// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { FileUploadedDto } from '@cogeto/shared';
import type { Session } from '../auth/oidc';

/**
 * A re-uploaded file says so, and points at what is already stored (#536).
 *
 * The rendering half of the fix matters as much as the dedup itself. The old
 * behaviour LOOKED right: a row appeared, it span, it settled, and the user
 * concluded their document had been ingested. It had, twice. So the card is
 * driven here through its real file input rather than through a re-stated
 * copy of its success handler, because a test that restates the branch it is
 * checking would pass while the component did the opposite.
 *
 *   duplicate_opens_what_exists — the page is handed the EXISTING source key,
 *     so the answer to "did this go in?" is the document itself.
 *   duplicate_starts_nothing — onUploaded is the "watch this job" callback,
 *     and behind a duplicate there is no job.
 *   duplicate_announces_itself — it is stated on the card, naming the file,
 *     not swallowed into a silent no-op.
 *   a_real_upload_is_untouched — the ordinary path keeps its pending row.
 */

const session = { accessToken: 'test' } as Session;
const EXISTING = 'org-1/user-a/private/file-existing';

const uploadFile = vi.fn<(...args: unknown[]) => Promise<FileUploadedDto>>();
vi.mock('../api', () => ({
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  fetchSettings: async () => ({ defaultScope: 'private', discardByDefault: false }),
  fetchFileStatus: async () => ({ state: 'processing' }),
  fetchFileSource: async () => ({ read: null }),
  reprocessSource: async () => ({ queued: true }),
}));

const { UploadCard } = await import('./UploadCard');

// React's own act-environment flag; without it every act() warns.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts the card and drops a real File on its input, as a user does. */
async function dropFile(result: FileUploadedDto) {
  uploadFile.mockResolvedValueOnce(result);
  const watched: string[] = [];
  const opened: string[] = [];

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UploadCard
          session={session}
          onUploaded={(key) => watched.push(key)}
          onDuplicate={(key) => opened.push(key)}
        />
      </QueryClientProvider>,
    );
  });

  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['%PDF-1.4 bytes'], 'flange.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Let the mutation's promise and its onSuccess flush.
  await act(async () => {
    await Promise.resolve();
  });

  const text = host.textContent ?? '';
  await act(async () => root.unmount());
  host.remove();
  return { watched, opened, text };
}

describe('re-uploading a file that is already stored', () => {
  it('duplicate_opens_what_exists, duplicate_starts_nothing, and says so', async () => {
    const { watched, opened, text } = await dropFile({ objectKey: EXISTING, duplicate: true });

    // No pending row: there is no pipeline job behind a duplicate, so a
    // spinner would be describing work that is not happening.
    expect(watched).toEqual([]);
    // The existing source, which is the honest answer to "is it in there?".
    expect(opened).toEqual([EXISTING]);
    // And it is stated, naming the file: several files dropped in a row must
    // not collapse into one anonymous "already there".
    expect(text).toContain('flange.pdf');
    expect(text.toLowerCase()).toContain('already stored');
  });

  it('a_real_upload_is_untouched: the ordinary path still watches its job', async () => {
    const key = 'org-1/user-a/private/file-new';
    const { watched, opened, text } = await dropFile({ objectKey: key, duplicate: false });
    expect(watched).toEqual([key]);
    expect(opened).toEqual([]);
    expect(text.toLowerCase()).not.toContain('already stored');
  });
});
