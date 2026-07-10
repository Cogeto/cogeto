import type { Principal } from '@cogeto/shared';

/**
 * The demo seed's ONE data-writing path: the real public HTTP API (decision
 * 0022; asserted by `demo_pipeline_real`). Every note, chat capture, and file
 * upload the sandbox contains goes through these endpoints exactly as a browser
 * would — so seeding the sandbox is a continuous integration test of the system.
 * This module performs NO database access and imports no domain module.
 */

export interface DemoApi {
  captureNote(text: string, scope?: 'private' | 'shared'): Promise<{ id: string }>;
  waitNote(id: string, timeoutMs?: number): Promise<void>;
  rememberChat(text: string): Promise<{ messageId: string }>;
  waitChat(messageId: string, timeoutMs?: number): Promise<void>;
  uploadFile(
    bytes: Buffer,
    filename: string,
    scope?: 'private' | 'shared',
  ): Promise<{ objectKey: string }>;
  waitFile(objectKey: string, timeoutMs?: number): Promise<void>;
  me(): Promise<Principal>;
}

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 120_000;
const PDF_CONTENT_TYPE = 'application/pdf';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createDemoApi(baseUrl: string, accessToken: string): DemoApi {
  const root = baseUrl.replace(/\/$/, '');
  const authHeaders = { authorization: `Bearer ${accessToken}` };

  async function call(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${root}${path}`, {
      ...init,
      headers: { ...authHeaders, ...(init?.headers ?? {}) },
    });
    return res;
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await call(path, init);
    if (!res.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async function pollStatus(
    path: string,
    label: string,
    timeoutMs: number,
    done: (state: string) => boolean,
    failed: (state: string) => boolean,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { state } = await json<{ state: string }>(path);
      if (done(state)) return;
      if (failed(state)) throw new Error(`${label} entered a failed state: ${state}`);
      if (Date.now() > deadline) throw new Error(`${label} did not finish within ${timeoutMs}ms`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  return {
    async captureNote(text, scope) {
      return json<{ id: string }>('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scope ? { content: text, scope } : { content: text }),
      });
    },

    waitNote(id, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return pollStatus(
        `/api/notes/${id}/status`,
        `note ${id}`,
        timeoutMs,
        (s) => s === 'done',
        (s) => s === 'failed',
      );
    },

    async rememberChat(text) {
      // POST /api/chat is an SSE stream; drain it so the turn is persisted. The
      // `done` event's messageId is the ASSISTANT reply — but only the USER
      // message can be remembered (decision 0021). Look it up by content and
      // remember that one (the explicit "remember this" capture).
      const res = await call('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`POST /api/chat → HTTP ${res.status}: ${await res.text()}`);
      }
      await drainSse(res.body);
      const messages = await json<ChatMessage[]>('/api/chat/messages');
      const userMessage = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && m.content === text);
      if (!userMessage) {
        throw new Error('could not find the persisted user chat message to remember');
      }
      await json(`/api/chat/messages/${userMessage.id}/remember`, { method: 'POST' });
      return { messageId: userMessage.id };
    },

    waitChat(messageId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return pollStatus(
        `/api/chat/messages/${messageId}/capture-status`,
        `chat capture ${messageId}`,
        timeoutMs,
        (s) => s === 'done',
        (s) => s === 'failed',
      );
    },

    async uploadFile(bytes, filename, scope) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: PDF_CONTENT_TYPE }), filename);
      if (scope) form.append('scope', scope);
      return json<{ objectKey: string }>('/api/files', { method: 'POST', body: form });
    },

    waitFile(objectKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return pollStatus(
        `/api/files/${encodeURIComponent(objectKey)}/status`,
        `file ${objectKey}`,
        timeoutMs,
        (s) => s === 'done',
        (s) => s === 'error',
      );
    },

    me() {
      return json<Principal>('/api/me');
    },
  };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** Consume the SSE body to completion (surfacing a stream `error` event). */
async function drainSse(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; each `data:` line is a JSON event.
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as { type?: string; message?: string };
        if (event.type === 'error') {
          throw new Error(`chat stream error: ${event.message ?? 'unknown'}`);
        }
      }
    }
    if (done) break;
  }
}
