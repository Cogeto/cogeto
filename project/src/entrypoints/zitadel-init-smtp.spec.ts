import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * zitadel-init notification SMTP.
 *
 * A deployed instance's Zitadel has no outbound mail unless it is given one,
 * so invitations, address verification and password resets silently go
 * nowhere. The settings arrive in the environment and the init applies them
 * through the Zitadel API. These are the behavioural assertions on the parts a
 * container cannot show cheaply: what counts as configured, what a partial
 * configuration does, what the unconfigured path records, and that re-applying
 * converges on ONE configuration instead of accumulating a second.
 *
 * The script is imported (it only provisions when RUN, not when imported) and
 * its transport is injected, so nothing here needs a Zitadel. The
 * state-file-reading part re-imports the module with the environment pointed
 * at a temporary file, because those paths are read once at module load.
 */
const INIT_PATH = path.resolve(
  process.cwd(),
  '../..',
  'project/infra/docker/zitadel-init/init.mjs',
);
const initModule = pathToFileURL(INIT_PATH).href;

type Outcome = { status: number; body?: unknown };
type Smtp = {
  host: string;
  user: string;
  password: string;
  tls: boolean;
  from: string;
  fromName: string;
};
type Init = {
  readSmtpSettings: (env: Record<string, string | undefined>) => Smtp | null;
  provisionedInputs: (smtp: Smtp | null) => Record<string, unknown>;
  shortCircuitFromState: (smtp: Smtp | null) => boolean;
  ensureSmtp: (
    pat: string,
    smtp: Smtp | null,
    options: {
      call: (method: string, apiPath: string, body: unknown, token?: string) => Promise<Outcome>;
    },
  ) => Promise<void>;
};

const load = async (): Promise<Init> => (await import(initModule)) as unknown as Init;

/** A fresh module instance whose file-path constants come from `env`. */
let cacheBust = 0;
const loadWithEnv = async (env: Record<string, string>): Promise<Init> => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  cacheBust += 1;
  return (await import(`${initModule}?instance=${cacheBust}`)) as unknown as Init;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const FULL_ENV = {
  ZITADEL_SMTP_HOST: 'smtp.example.com:587',
  ZITADEL_SMTP_USER: 'postbox',
  ZITADEL_SMTP_PASSWORD: 'the-secret',
  ZITADEL_SMTP_TLS: 'true',
  ZITADEL_SMTP_FROM: 'no-reply@example.com',
  ZITADEL_SMTP_FROM_NAME: 'Cogeto',
};

describe('zitadel-init SMTP configuration reading', () => {
  it('reads nothing when every value is empty or absent: no SMTP is a configuration too', async () => {
    const { readSmtpSettings } = await load();
    expect(readSmtpSettings({})).toBeNull();
    expect(
      readSmtpSettings({
        ZITADEL_SMTP_HOST: '',
        ZITADEL_SMTP_USER: '',
        ZITADEL_SMTP_PASSWORD: '',
        ZITADEL_SMTP_TLS: '',
        ZITADEL_SMTP_FROM: '',
        ZITADEL_SMTP_FROM_NAME: '',
      }),
    ).toBeNull();
    // Whitespace is emptiness: a rendered template that produced a blank line
    // must not read as a half-configured relay.
    expect(readSmtpSettings({ ZITADEL_SMTP_HOST: '   ' })).toBeNull();
  });

  it('reads a complete configuration, with TLS as a boolean and no credential when none is given', async () => {
    const { readSmtpSettings } = await load();
    expect(readSmtpSettings(FULL_ENV)).toEqual({
      host: 'smtp.example.com:587',
      user: 'postbox',
      password: 'the-secret',
      tls: true,
      from: 'no-reply@example.com',
      fromName: 'Cogeto',
    });
    const unauthenticated = readSmtpSettings({
      ...FULL_ENV,
      ZITADEL_SMTP_USER: '',
      ZITADEL_SMTP_PASSWORD: '',
      ZITADEL_SMTP_TLS: 'false',
    });
    expect(unauthenticated).toMatchObject({ user: '', password: '', tls: false });
  });

  it('refuses a partial configuration, naming exactly the variables that are missing', async () => {
    const { readSmtpSettings } = await load();
    expect(() => readSmtpSettings({ ZITADEL_SMTP_HOST: 'smtp.example.com:587' })).toThrow(
      /ZITADEL_SMTP_FROM, ZITADEL_SMTP_FROM_NAME, ZITADEL_SMTP_TLS are missing/,
    );
    expect(() => readSmtpSettings({ ...FULL_ENV, ZITADEL_SMTP_FROM: '' })).toThrow(
      /ZITADEL_SMTP_FROM is missing/,
    );
    expect(() => readSmtpSettings({ ...FULL_ENV, ZITADEL_SMTP_HOST: '' })).toThrow(
      /ZITADEL_SMTP_HOST is missing/,
    );
  });

  it('refuses half a credential in either direction', async () => {
    const { readSmtpSettings } = await load();
    expect(() => readSmtpSettings({ ...FULL_ENV, ZITADEL_SMTP_PASSWORD: '' })).toThrow(
      /ZITADEL_SMTP_PASSWORD is missing/,
    );
    expect(() => readSmtpSettings({ ...FULL_ENV, ZITADEL_SMTP_USER: '' })).toThrow(
      /ZITADEL_SMTP_USER is missing/,
    );
  });

  it('refuses a TLS value that is not exactly true or false, rather than defaulting it', async () => {
    const { readSmtpSettings } = await load();
    for (const value of ['yes', 'TRUE', '1', 'starttls']) {
      expect(() => readSmtpSettings({ ...FULL_ENV, ZITADEL_SMTP_TLS: value }), value).toThrow(
        /ZITADEL_SMTP_TLS must be exactly "true" or "false"/,
      );
    }
  });

  it('never quotes the credential in a refusal', async () => {
    const { readSmtpSettings } = await load();
    const partial = { ...FULL_ENV, ZITADEL_SMTP_USER: '', ZITADEL_SMTP_PASSWORD: 'the-secret' };
    expect(() => readSmtpSettings(partial)).toThrow();
    try {
      readSmtpSettings(partial);
    } catch (error) {
      expect((error as Error).message).not.toContain('the-secret');
    }
    // The same for the TLS refusal, which does quote the value it rejected.
    try {
      readSmtpSettings({ ...FULL_ENV, ZITADEL_SMTP_TLS: 'maybe' });
    } catch (error) {
      expect((error as Error).message).not.toContain('the-secret');
    }
  });
});

describe('zitadel-init provisioned inputs', () => {
  it('records nothing about mail when none is configured: the unconfigured state file is unchanged', async () => {
    const { provisionedInputs } = await load();
    // The six keys that existed before notification mail did, in order. A
    // seventh key here would rewrite the state file every deployed instance
    // already holds, and every one of them would then read as drifted.
    expect(Object.keys(provisionedInputs(null))).toEqual([
      'externalDomain',
      'issuer',
      'redirectUri',
      'postLogoutUri',
      'adminUsername',
      'adminRole',
    ]);
  });

  it('records the SMTP identity but never the credential', async () => {
    const { readSmtpSettings, provisionedInputs } = await load();
    const inputs = provisionedInputs(readSmtpSettings(FULL_ENV));
    expect(inputs).toMatchObject({
      smtpHost: 'smtp.example.com:587',
      smtpUser: 'postbox',
      smtpTls: true,
      smtpFrom: 'no-reply@example.com',
      smtpFromName: 'Cogeto',
    });
    expect(JSON.stringify(inputs)).not.toContain('the-secret');
  });
});

describe('zitadel-init short-circuit against a revoked bootstrap PAT', () => {
  const withState = async (state: unknown): Promise<Init> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zitadel-init-smtp-'));
    const stateFile = path.join(dir, 'bootstrap-state.json');
    writeFileSync(stateFile, JSON.stringify(state));
    return loadWithEnv({
      ZITADEL_BOOTSTRAP_STATE_FILE: stateFile,
      ZITADEL_EXTERNAL_DOMAIN: 'instance.example',
      COGETO_ISSUER: 'https://instance.example',
      COGETO_REDIRECT_URI: 'https://instance.example/callback',
      COGETO_POST_LOGOUT_URI: 'https://instance.example/',
      ZITADEL_ADMIN_USERNAME: 'admin@instance.example',
      COGETO_ADMIN_ROLE: 'admin',
    });
  };

  const PROVISIONED = {
    externalDomain: 'instance.example',
    issuer: 'https://instance.example',
    redirectUri: 'https://instance.example/callback',
    postLogoutUri: 'https://instance.example/',
    adminUsername: 'admin@instance.example',
    adminRole: 'admin',
  };

  it('short-circuits an already-provisioned instance that never had mail, exactly as before', async () => {
    const init = await withState({ revoked: true, inputs: PROVISIONED });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(init.shortCircuitFromState(null)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nothing to do'));
    warn.mockRestore();
    log.mockRestore();
  });

  it('names mail that was NOT applied and still lets the instance come up', async () => {
    // The upgrade case: an instance provisioned before this existed, with the
    // platform now rendering a relay into its environment.
    const init = await withState({ revoked: true, inputs: PROVISIONED });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(init.shortCircuitFromState(init.readSmtpSettings(FULL_ENV))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOTHING was applied'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('smtpHost'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('the-secret');
    warn.mockRestore();
    log.mockRestore();
  });

  it('sees mail taken back OUT of the environment, which absent keys alone cannot show', async () => {
    const init = await withState({
      revoked: true,
      inputs: { ...PROVISIONED, smtpHost: 'smtp.example.com:587', smtpFrom: 'x@example.com' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(init.shortCircuitFromState(null)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('smtpHost, smtpFrom'));
    // And says the true thing about it: deleting the variables stops this job
    // managing the relay, it does not switch off one Zitadel already has.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KEEPS SENDING'));
    warn.mockRestore();
    log.mockRestore();
  });

  it('still FAILS on a changed domain: mail is the exception, not a general softening', async () => {
    const init = await withState({
      revoked: true,
      inputs: { ...PROVISIONED, issuer: 'https://old.example' },
    });
    expect(() => init.shortCircuitFromState(null)).toThrow(
      /provisioning inputs changed \(issuer\)/,
    );
  });
});

describe('zitadel-init SMTP application', () => {
  const settings: Smtp = {
    host: 'smtp.example.com:587',
    user: 'postbox',
    password: 'the-secret',
    tls: true,
    from: 'no-reply@example.com',
    fromName: 'Cogeto',
  };
  const OURS = {
    id: 'cfg-1',
    description: 'cogeto',
    state: 'SMTP_CONFIG_ACTIVE',
    senderAddress: settings.from,
    senderName: settings.fromName,
    host: settings.host,
    user: settings.user,
    tls: true,
  };

  /** A transport that answers from a script and records what it was asked. */
  const transport = (answer: (method: string, apiPath: string, body: unknown) => Outcome) => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    return {
      calls,
      call: async (method: string, apiPath: string, body: unknown): Promise<Outcome> => {
        calls.push({ method, path: apiPath, body });
        return answer(method, apiPath, body);
      },
    };
  };

  it('calls nothing at all when no mail is configured', async () => {
    const { ensureSmtp } = await load();
    const t = transport(() => {
      throw new Error('the unconfigured path must not reach the API');
    });
    await ensureSmtp('pat', null, { call: t.call });
    expect(t.calls).toEqual([]);
  });

  it('creates, sets the credential and activates when the instance has no configuration', async () => {
    // The listing stays empty throughout: Zitadel serves it from a projection
    // that has not caught up when the create answers, so a create that needed
    // to read itself back would fail here. The returned id is the answer.
    const { ensureSmtp } = await load();
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search') return { status: 200, body: {} };
      if (method === 'POST' && apiPath === '/admin/v1/smtp') {
        return { status: 200, body: { id: OURS.id } };
      }
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) return { status: 200, body: {} };
      if (apiPath === `/admin/v1/smtp/${OURS.id}/_activate`) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp') return { status: 200, body: { smtpConfig: OURS } };
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    const paths = t.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /admin/v1/smtp');
    expect(paths).toContain(`PUT /admin/v1/smtp/${OURS.id}/password`);
    expect(paths).toContain(`POST /admin/v1/smtp/${OURS.id}/_activate`);
    // The credential travels in exactly the two calls that need it and
    // nowhere else.
    const carriers = t.calls.filter((c) => JSON.stringify(c.body ?? {}).includes('the-secret'));
    expect(carriers.map((c) => c.path)).toEqual([
      '/admin/v1/smtp',
      `/admin/v1/smtp/${OURS.id}/password`,
    ]);
  });

  it('converges on the existing configuration instead of creating a second one', async () => {
    const { ensureSmtp } = await load();
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search') return { status: 200, body: { result: [OURS] } };
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: OURS } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    const paths = t.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).not.toContain('POST /admin/v1/smtp');
    expect(paths).not.toContain(`PUT /admin/v1/smtp/${OURS.id}`);
    // Already active: activating again would answer 400 AlreadyActive.
    expect(paths).not.toContain(`POST /admin/v1/smtp/${OURS.id}/_activate`);
  });

  it('REPLACES changed settings on the one configuration rather than adding another', async () => {
    const { ensureSmtp } = await load();
    const moved = { ...OURS, host: 'old-relay.example:25' };
    let updated: Record<string, unknown> | undefined;
    const t = transport((method, apiPath, body) => {
      if (apiPath === '/admin/v1/smtp/_search') {
        return { status: 200, body: { result: [updated ? OURS : moved] } };
      }
      if (method === 'PUT' && apiPath === `/admin/v1/smtp/${OURS.id}`) {
        updated = body as Record<string, unknown>;
        return { status: 200, body: {} };
      }
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: OURS } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    expect(updated).toMatchObject({ host: settings.host, description: 'cogeto' });
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).not.toContain('POST /admin/v1/smtp');
    // The update body carries no password: Zitadel takes it on its own call.
    expect(JSON.stringify(updated)).not.toContain('the-secret');
  });

  it('finds a configuration a previous run created but never activated, and activates it', async () => {
    // The one GET /admin/v1/smtp cannot see: inactive configurations are
    // absent from it, so a read-based implementation would create a second.
    const { ensureSmtp } = await load();
    const inactive = { ...OURS, state: 'SMTP_CONFIG_INACTIVE' };
    let active = false;
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search')
        return { status: 200, body: { result: [inactive] } };
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) return { status: 200, body: {} };
      if (apiPath === `/admin/v1/smtp/${OURS.id}/_activate`) {
        active = true;
        return { status: 200, body: {} };
      }
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return active
          ? { status: 200, body: { smtpConfig: OURS } }
          : { status: 404, body: { message: 'SMTP configuration not found' } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    expect(active).toBe(true);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).not.toContain('POST /admin/v1/smtp');
  });

  it('leaves a hand-made configuration alone and manages only its own', async () => {
    const { ensureSmtp } = await load();
    const handMade = { ...OURS, id: 'cfg-operator', description: 'set up by hand' };
    let createdBody: Record<string, unknown> | undefined;
    const t = transport((method, apiPath, body) => {
      if (apiPath === '/admin/v1/smtp/_search') {
        return { status: 200, body: { result: [handMade] } };
      }
      if (method === 'POST' && apiPath === '/admin/v1/smtp') {
        createdBody = body as Record<string, unknown>;
        return { status: 200, body: { id: OURS.id } };
      }
      if (apiPath.startsWith(`/admin/v1/smtp/${OURS.id}`)) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: OURS } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    expect(createdBody).toBeDefined();
    expect(t.calls.some((c) => c.path.includes('cfg-operator'))).toBe(false);
  });

  it('converges rather than duplicating when the create lands but its answer is lost', async () => {
    const { ensureSmtp } = await load();
    let creates = 0;
    let exists = false;
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search') {
        return {
          status: 200,
          body: exists ? { result: [{ ...OURS, state: 'SMTP_CONFIG_INACTIVE' }] } : {},
        };
      }
      if (method === 'POST' && apiPath === '/admin/v1/smtp') {
        creates += 1;
        exists = true; // the server applied it
        const reset = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        throw reset;
      }
      if (apiPath.startsWith(`/admin/v1/smtp/${OURS.id}`)) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: OURS } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    expect(creates).toBe(1);
  });

  it('waits out a management API that is still binding, like every call around it', async () => {
    const { ensureSmtp } = await load();
    let listAttempts = 0;
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search') {
        listAttempts += 1;
        if (listAttempts < 3) return { status: 503 };
        return { status: 200, body: { result: [OURS] } };
      }
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: OURS } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await ensureSmtp('pat', settings, { call: t.call });
    expect(listAttempts).toBe(3);
  });

  it('fails loudly when the configuration did not become the active one', async () => {
    const { ensureSmtp } = await load();
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search') return { status: 200, body: { result: [OURS] } };
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) return { status: 200, body: {} };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: { ...OURS, id: 'someone-elses' } } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await expect(ensureSmtp('pat', settings, { call: t.call })).rejects.toThrow(
      /notification SMTP did not stick/,
    );
  });

  it('never puts the credential in the error a failed credential update raises', async () => {
    const { ensureSmtp } = await load();
    const t = transport((method, apiPath) => {
      if (apiPath === '/admin/v1/smtp/_search') return { status: 200, body: { result: [OURS] } };
      if (apiPath === '/admin/v1/smtp' && method === 'GET') {
        return { status: 200, body: { smtpConfig: OURS } };
      }
      if (apiPath === `/admin/v1/smtp/${OURS.id}/password`) {
        // Zitadel's validator echoes the request shape; nothing from that body
        // may reach the message.
        return { status: 400, body: { message: 'invalid password "the-secret"' } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    await expect(ensureSmtp('pat', settings, { call: t.call })).rejects.toThrow(
      /smtp credential update failed \(400\)/,
    );
    await ensureSmtp('pat', settings, { call: t.call }).catch((error: Error) => {
      expect(error.message).not.toContain('the-secret');
    });
  });
});
