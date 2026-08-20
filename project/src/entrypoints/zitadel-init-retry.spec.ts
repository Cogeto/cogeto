import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * zitadel-init management-API retries.
 *
 * /debug/healthz answers before Zitadel's management gateway has finished
 * binding, so a provisioning call can come back 503 or with a refused
 * connection at any point. These are the behavioural assertions on the bounded
 * retry that absorbs it: what is waited out, what is fatal, how the wait ends,
 * and that a retry of a creating call converges instead of duplicating.
 *
 * The script is imported (it only provisions when RUN, not when imported), and
 * its transport is injected, so nothing here needs a Zitadel.
 */
const initModule = pathToFileURL(
  path.resolve(process.cwd(), '../..', 'project/infra/docker/zitadel-init/init.mjs'),
).href;

type Outcome = { status: number; body?: unknown };
type Init = {
  isNotYet: (outcome: unknown) => boolean;
  api: (
    method: string,
    apiPath: string,
    body: unknown,
    token: string | undefined,
    options: {
      label?: string;
      recheck?: () => Promise<Outcome | null>;
      attempts?: number;
      windowMs?: number;
      call?: (method: string, apiPath: string, body: unknown, token?: string) => Promise<Outcome>;
    },
  ) => Promise<Outcome>;
};

const load = async (): Promise<Init> => (await import(initModule)) as unknown as Init;

const connectionError = (code: string): Error => Object.assign(new Error(code), { code });

describe('zitadel-init retry classification', () => {
  it('treats 503 and refused, reset or dial failures as "not yet"', async () => {
    const { isNotYet } = await load();
    expect(isNotYet({ status: 503 })).toBe(true);
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND']) {
      expect(isNotYet(connectionError(code)), code).toBe(true);
    }
  });

  it('treats an understood answer as final: success, auth failure, bad request, timeout', async () => {
    const { isNotYet } = await load();
    for (const status of [200, 400, 401, 403, 404, 409, 500]) {
      expect(isNotYet({ status }), String(status)).toBe(false);
    }
    expect(isNotYet(connectionError('ETIMEDOUT'))).toBe(false);
  });
});

describe('zitadel-init bounded retry', () => {
  it('waits out a gateway that is still binding and then succeeds', async () => {
    const { api } = await load();
    const answers: Outcome[] = [
      { status: 503 },
      { status: 503 },
      { status: 200, body: { id: 'p' } },
    ];
    let calls = 0;
    const result = await api('POST', '/management/v1/projects/_search', {}, 'pat', {
      label: 'project search',
      call: async () => answers[calls++]!,
    });
    expect(calls).toBe(3);
    expect(result).toEqual({ status: 200, body: { id: 'p' } });
  });

  it('does not retry a call the server understood and rejected', async () => {
    const { api } = await load();
    let calls = 0;
    const result = await api('POST', '/management/v1/projects', {}, 'pat', {
      label: 'project create',
      call: async () => {
        calls++;
        return { status: 401, body: { message: 'unauthenticated' } };
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe(401);
  });

  it('propagates a connection failure that is not "not yet" on the first attempt', async () => {
    const { api } = await load();
    let calls = 0;
    await expect(
      api('GET', '/admin/v1/restrictions', null, 'pat', {
        label: 'restrictions read',
        call: async () => {
          calls++;
          throw connectionError('ETIMEDOUT');
        },
      }),
    ).rejects.toThrow('ETIMEDOUT');
    expect(calls).toBe(1);
  });

  it('gives up at the attempt cap and names the call, the attempts and the elapsed time', async () => {
    const { api } = await load();
    let calls = 0;
    await expect(
      api('POST', '/management/v1/projects/_search', {}, 'pat', {
        label: 'project search',
        attempts: 3,
        call: async () => {
          calls++;
          return { status: 503 };
        },
      }),
    ).rejects.toThrow(/project search: .*3 attempt\(s\) over \d+s, last failure HTTP 503/);
    expect(calls).toBe(3);
  });

  it('gives up at the elapsed-time cap even when attempts remain', async () => {
    const { api } = await load();
    let calls = 0;
    await expect(
      api('GET', '/admin/v1/policies/login', null, 'pat', {
        label: 'login policy read',
        windowMs: 0,
        call: async () => {
          calls++;
          throw connectionError('ECONNREFUSED');
        },
      }),
    ).rejects.toThrow(/login policy read: .*1 attempt\(s\).*ECONNREFUSED/);
    expect(calls).toBe(1);
  });

  it('converges on what a lost response already created instead of creating it twice', async () => {
    const { api } = await load();
    let calls = 0;
    let created = false;
    const result = await api('POST', '/management/v1/projects', { name: 'cogeto' }, 'pat', {
      label: 'project create',
      // The create lands, then the connection resets before the answer arrives.
      call: async () => {
        calls++;
        created = true;
        throw connectionError('ECONNRESET');
      },
      recheck: async () => (created ? { status: 200, body: { id: 'existing' } } : null),
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ status: 200, body: { id: 'existing' } });
  });
});
