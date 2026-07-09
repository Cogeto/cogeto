import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FileProcessingState, MemoryScope } from '@cogeto/shared';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  DEFAULT_UPLOAD_MAX_BYTES,
} from '@cogeto/shared';
import { fetchFileStatus, fetchSettings, uploadFile } from '../api';
import type { Session } from '../auth/oidc';

/** Client-side pre-check — the server re-validates type (magic bytes) and size. */
function validate(file: File): string | null {
  const name = file.name.toLowerCase();
  const okExt = ALLOWED_UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext));
  const okType = !file.type || ALLOWED_UPLOAD_CONTENT_TYPES.includes(file.type);
  if (!okExt && !okType) return 'Only PDF and DOCX files are accepted.';
  if (file.size > DEFAULT_UPLOAD_MAX_BYTES) {
    return `File is too large (max ${Math.round(DEFAULT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB).`;
  }
  if (file.size === 0) return 'That file is empty.';
  return null;
}

/**
 * The Memories upload affordance beside the capture card (O1): drag-or-select a
 * PDF/DOCX, choose scope + sensitive, and it enters the SAME pipeline as a note.
 * Derived facts appear in the list below once verified.
 */
export function UploadCard({
  session,
  onUploaded,
}: {
  session: Session;
  onUploaded: (objectKey: string, filename: string) => void;
}) {
  // Prefill scope + discard from the user's saved defaults (§A.9, O1-C).
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [sensitive, setSensitive] = useState(false);
  const [discard, setDiscard] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const effScope = scope ?? settings.data?.defaultScope ?? 'private';
  const effDiscard = discard ?? settings.data?.discardByDefault ?? false;

  const upload = useMutation({
    mutationFn: ({ file }: { file: File }) =>
      uploadFile(session, file, { scope: effScope, sensitive, discard: effDiscard }),
    onSuccess: (result, { file }) => onUploaded(result.objectKey, file.name),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const submit = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const problem = validate(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload.mutate({ file });
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          submit(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center text-sm transition-colors ${
          dragging ? 'border-brand-teal bg-brand-teal/5' : 'border-slate-300'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_UPLOAD_EXTENSIONS.join(',')}
          className="hidden"
          onChange={(e) => {
            submit(e.target.files?.[0]);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
        <p className="font-medium text-slate-600">
          {upload.isPending ? 'Uploading…' : 'Drop a PDF or DOCX here, or click to choose'}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Its facts are extracted, verified and added to your memories.
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <label className="flex items-center gap-1.5">
          Scope
          <select
            value={effScope}
            onChange={(e) => setScope(e.target.value as MemoryScope)}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="private">private</option>
            <option value="shared">shared</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
          />
          Sensitive
        </label>
        <label
          className="flex items-center gap-1.5"
          title="Delete the original after extraction — keep only the derived memories (§A.9)."
        >
          <input
            type="checkbox"
            checked={effDiscard}
            onChange={(e) => setDiscard(e.target.checked)}
          />
          Discard original after extraction
        </label>
      </div>

      {effDiscard && (
        <p className="mt-2 text-xs text-amber-600">
          The uploaded file will be deleted once its facts are extracted — only the verified
          memories are kept. This cannot be undone.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}

const STATE_LABEL: Record<FileProcessingState, string> = {
  processing: 'Extracting and verifying…',
  done: 'Done',
  error: 'Extraction failed — the file could not be read.',
};

/** Polls one uploaded file's pipeline job until it settles. */
export function PendingUpload({
  session,
  objectKey,
  filename,
  onSettled,
}: {
  session: Session;
  objectKey: string;
  filename: string;
  onSettled: (objectKey: string, failed: boolean) => void;
}) {
  const { data } = useQuery({
    queryKey: ['file-status', objectKey],
    queryFn: () => fetchFileStatus(session, objectKey),
    refetchInterval: (query) => (query.state.data?.state === 'processing' ? 1500 : false),
  });
  const state = data?.state ?? 'processing';

  useEffect(() => {
    if (state !== 'processing') onSettled(objectKey, state === 'error');
  }, [state, objectKey, onSettled]);

  const failed = state === 'error';
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
        failed
          ? 'border-red-200 bg-red-50 text-red-600'
          : 'border-slate-200 bg-white text-slate-500'
      }`}
    >
      {!failed && <span className="h-2 w-2 animate-pulse rounded-full bg-brand-teal" />}
      <span className="truncate font-medium text-slate-600">{filename}</span>
      <span className="ml-auto text-xs">{STATE_LABEL[state]}</span>
    </div>
  );
}
