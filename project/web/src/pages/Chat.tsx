import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatFactDto } from '@cogeto/shared';
import { mapMarkersToCitations, scanAnswer } from '@cogeto/shared';
import { askChat, fetchChatMessages } from '../api';
import type { Session } from '../auth/oidc';
import { CitationChip } from '../components/CitationChip';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';

/**
 * Chat (S3-A/S3.5-A): grounded answers over the user's memories. The one
 * citation grammar is `{{cite:<uuid>}}` (decision 0007 ruling 2). Stored
 * messages already contain only canonical cites; live streaming text is
 * canonicalized here from the model's `[F#]` markers (via the SSE sources map)
 * and every non-conforming token is stripped — no raw marker ever reaches the
 * screen. Chips deep-link into the Memories governance drawer (S3-B).
 */
function MessageBody({
  session,
  content,
  facts,
  onOpenMemory,
}: {
  session: Session;
  content: string;
  facts?: ChatFactDto[];
  onOpenMemory: (memoryId: string) => void;
}) {
  // Live text carries `[F#]` markers + a facts map; canonicalize first, then
  // scan. Stored text has no facts map and is already canonical/sanitized.
  const markerMap = new Map((facts ?? []).map((f) => [f.marker, f.memoryId]));
  const canonical = facts ? mapMarkersToCitations(content, markerMap) : content;
  const validIds = facts ? new Set(facts.map((f) => f.memoryId)) : undefined;
  const { segments } = scanAnswer(canonical, validIds);

  let ordinal = 0;
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">
      {segments.map((segment, i) => {
        if (segment.kind === 'text') return <span key={i}>{segment.text}</span>;
        ordinal += 1;
        return (
          <CitationChip
            key={i}
            session={session}
            ordinal={ordinal}
            memoryId={segment.memoryId}
            fact={facts?.find((f) => f.memoryId === segment.memoryId)}
            onOpen={onOpenMemory}
          />
        );
      })}
    </p>
  );
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          role === 'user'
            ? 'bg-brand-navy-deep text-white'
            : 'border border-slate-200 bg-white text-slate-800 shadow-sm'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function Chat({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const { data: history, isPending } = useQuery({
    queryKey: ['chat-messages'],
    queryFn: () => fetchChatMessages(session),
  });

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveFacts, setLiveFacts] = useState<ChatFactDto[]>([]);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pin the view to the latest message: scroll the message pane itself (never
  // the page — the input stays fixed at the bottom) on history and stream
  // updates.
  useEffect(() => {
    const pane = scrollRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [history, liveText, liveQuestion]);

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setFailed(false);
    setDraft('');
    setLiveQuestion(content);
    setLiveText('');
    setLiveFacts([]);
    try {
      await askChat(session, content, (event) => {
        if (event.type === 'sources') setLiveFacts(event.facts);
        else if (event.type === 'token') setLiveText((text) => text + event.text);
        else if (event.type === 'error') setFailed(true);
      });
    } catch {
      setFailed(true);
    }
    await queryClient.invalidateQueries({ queryKey: ['chat-messages'] });
    setLiveQuestion(null);
    setLiveText('');
    setLiveFacts([]);
    setBusy(false);
  };

  const empty = !isPending && (history?.length ?? 0) === 0 && !liveQuestion;

  return (
    <Shell session={session} title="Chat" active="chat" fullHeight>
      <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {isPending && <p className="text-sm text-slate-400">Loading conversation…</p>}
          {empty && (
            <div className="rounded-md border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
              <p className="font-medium text-slate-600">Ask about anything you have captured.</p>
              <p className="mt-1">
                Answers come only from your memories — every claim carries a citation chip that
                opens its source. Nothing on record yet? Capture a note on the{' '}
                <a href="/memories" className="text-brand-teal hover:underline">
                  Memories
                </a>{' '}
                page first.
              </p>
            </div>
          )}
          {history?.map((message) => (
            <Bubble key={message.id} role={message.role}>
              <MessageBody
                session={session}
                content={message.content}
                onOpenMemory={setOpenMemoryId}
              />
            </Bubble>
          ))}
          {liveQuestion && (
            <Bubble role="user">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{liveQuestion}</p>
            </Bubble>
          )}
          {liveQuestion && (
            <Bubble role="assistant">
              {liveText ? (
                <MessageBody
                  session={session}
                  content={liveText}
                  facts={liveFacts}
                  onOpenMemory={setOpenMemoryId}
                />
              ) : (
                <p className="text-sm text-slate-400">Searching your memories…</p>
              )}
            </Bubble>
          )}
          {failed && <p className="text-sm text-red-600">Answer generation failed — ask again.</p>}
        </div>
        <form
          className="mt-4 flex shrink-0 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your commitments, decisions, people…"
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="rounded-md bg-brand-teal px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Answering…' : 'Ask'}
          </button>
        </form>
      </section>
      {openMemoryId && (
        <MemoryDrawer
          session={session}
          memoryId={openMemoryId}
          onClose={() => setOpenMemoryId(null)}
          onNavigate={setOpenMemoryId}
        />
      )}
    </Shell>
  );
}
