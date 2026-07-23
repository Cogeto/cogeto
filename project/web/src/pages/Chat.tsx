import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatFactDto, ChatResearchOffer } from '@cogeto/shared';
import { mapMarkersToCitations, mapUnsourcedMarkers, scanAnswer } from '@cogeto/shared';
import {
  askChat,
  fetchChatCaptureStatus,
  fetchChatMessages,
  proposeResearch,
  rememberChatMessage,
} from '../api';
import type { Session } from '../auth/oidc';
import { CitationChip } from '../components/CitationChip';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';
import { UnsourcedChip } from '../components/UnsourcedChip';

/**
 * Chat (S3-A/S3.5-A): grounded answers over the user's memories, blended with
 * marked model knowledge when the question asks about the wider world
 * (decision 0046). The citation grammar is `{{cite:<uuid>}}` plus the
 * `{{unsourced}}` marker (decisions 0007/0046). Stored messages already
 * contain only canonical tokens; live streaming text is canonicalized here
 * from the model's `[F#]`/`[U]` markers (via the SSE sources map) and every
 * non-conforming token is stripped — no raw marker ever reaches the screen.
 * Chips deep-link into the Memories governance drawer (S3-B).
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
  // Live text carries `[F#]`/`[U]` markers + a facts map; canonicalize first,
  // then scan. Stored text has no facts map and is already canonical/sanitized.
  const markerMap = new Map((facts ?? []).map((f) => [f.marker, f.memoryId]));
  const canonical = facts
    ? mapUnsourcedMarkers(mapMarkersToCitations(content, markerMap))
    : content;
  const validIds = facts ? new Set(facts.map((f) => f.memoryId)) : undefined;
  const { segments } = scanAnswer(canonical, validIds);

  let ordinal = 0;
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">
      {segments.map((segment, i) => {
        if (segment.kind === 'text') return <span key={i}>{segment.text}</span>;
        if (segment.kind === 'unsourced') return <UnsourcedChip key={i} />;
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

/**
 * The research offer (decision 0046): a one-tap bridge from a knowledge
 * answer into the EXISTING minimise-and-approve gate. Tapping proposes a run
 * (nothing is sent) and lands on the Research page, where the gate opens as
 * always. The offer is the bridge; the gate stays the gate.
 */
function ResearchOfferChip({ session, offer }: { session: Session; offer: ChatResearchOffer }) {
  const propose = useMutation({
    mutationFn: () => proposeResearch(session, offer.topic),
    onSuccess: () => {
      window.location.href = '/research';
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2 pl-1">
      <button
        type="button"
        onClick={() => propose.mutate()}
        disabled={propose.isPending}
        className="rounded-full border border-brand-teal/40 bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-teal-ink transition-colors hover:bg-brand-teal/20 disabled:opacity-40"
      >
        {propose.isPending ? 'Preparing…' : 'Research this on the web →'}
      </button>
      <span className="text-xs text-slate-400">
        {propose.isError
          ? 'Couldn’t prepare that research — try the Research page.'
          : 'You’ll see and approve exactly what is sent — nothing leaves until then.'}
      </span>
    </div>
  );
}

/**
 * "Remember this" on a user message (O2-C, decision 0021): routes the message
 * through the pipeline and polls capture progress. Only user messages get this —
 * the assistant's replies are never captured.
 */
function RememberAction({ session, messageId }: { session: Session; messageId: string }) {
  const queryClient = useQueryClient();
  const [captured, setCaptured] = useState(false);
  const remember = useMutation({
    mutationFn: () => rememberChatMessage(session, messageId),
    onSuccess: () => setCaptured(true),
  });
  // Poll the pipeline once capture starts; stop when it settles.
  const status = useQuery({
    queryKey: ['chat-capture', messageId],
    queryFn: () => fetchChatCaptureStatus(session, messageId),
    enabled: captured,
    refetchInterval: (query) =>
      query.state.data && query.state.data.state !== 'processing' ? false : 1500,
  });
  useEffect(() => {
    if (status.data?.state === 'done') {
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
    }
  }, [status.data?.state, queryClient]);

  if (!captured) {
    return (
      <button
        type="button"
        onClick={() => remember.mutate()}
        disabled={remember.isPending}
        className="mt-0.5 text-xs text-white/60 underline decoration-white/30 underline-offset-2 hover:text-white disabled:opacity-40"
        title="Remember this message — it becomes memory through the normal pipeline"
      >
        {remember.isPending ? 'Remembering…' : 'Remember this'}
      </button>
    );
  }
  const state = status.data?.state ?? 'processing';
  const label =
    state === 'done'
      ? 'Remembered ✓'
      : state === 'failed'
        ? 'Capture failed'
        : 'Remembering… extracting & verifying';
  return (
    <span className={`mt-0.5 text-xs ${state === 'failed' ? 'text-red-300' : 'text-white/60'}`}>
      {label}
    </span>
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

  // A ?q= param prefills the box — the timeline's "Explain in chat" hand-off
  // lands here with the question ready to send (never auto-sent).
  const [draft, setDraft] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Specific failure copy (FIX-2): rate limit / daily budget / timeout. */
  const [failMessage, setFailMessage] = useState<string | null>(null);
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveFacts, setLiveFacts] = useState<ChatFactDto[]>([]);
  /** The latest answer's research offer (0046) — ephemeral, cleared on the next ask. */
  const [offer, setOffer] = useState<ChatResearchOffer | null>(null);
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
    setFailMessage(null);
    setDraft('');
    setLiveQuestion(content);
    setLiveText('');
    setLiveFacts([]);
    setOffer(null);
    try {
      await askChat(session, content, (event) => {
        if (event.type === 'sources') setLiveFacts(event.facts);
        else if (event.type === 'token') setLiveText((text) => text + event.text);
        else if (event.type === 'done') setOffer(event.researchOffer ?? null);
        else if (event.type === 'error') {
          setFailed(true);
          // Specific copy for the daily budget / stream-timeout aborts (FIX-2).
          if (event.code === 'model_budget_exceeded' || event.code === 'timeout') {
            setFailMessage(event.message);
          }
        }
      });
    } catch (error) {
      // A pre-stream 429 (rate limit / too many streams) throws with the
      // server's message; show it verbatim.
      setFailed(true);
      setFailMessage(error instanceof Error ? error.message : null);
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
              <p className="font-medium text-slate-600">
                Ask anything — every claim shows what it can prove.
              </p>
              <p className="mt-1">
                Answers ground in your own memories first (each claim carries a chip that opens its
                source); anything from the model’s general knowledge is marked{' '}
                <span className="italic">unsourced</span>, and the web is searched only when you ask
                and approve. Start by capturing a note on the{' '}
                <a href="/memories" className="text-brand-teal-ink hover:underline">
                  Memories
                </a>{' '}
                page, or just say hello.
              </p>
            </div>
          )}
          {history?.map((message) => (
            <div
              key={message.id}
              className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <Bubble role={message.role}>
                <MessageBody
                  session={session}
                  content={message.content}
                  onOpenMemory={setOpenMemoryId}
                />
                {message.role === 'user' && (
                  <RememberAction session={session} messageId={message.id} />
                )}
              </Bubble>
            </div>
          ))}
          {liveQuestion && (
            <Bubble role="user">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{liveQuestion}</p>
            </Bubble>
          )}
          {liveQuestion && (
            <Bubble role="assistant">
              <div aria-live="polite" aria-busy={!liveText}>
                {liveText ? (
                  <MessageBody
                    session={session}
                    content={liveText}
                    facts={liveFacts}
                    onOpenMemory={setOpenMemoryId}
                  />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-slate-400">
                    <span className="inline-flex gap-0.5" aria-hidden="true">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300 [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300 [animation-delay:300ms]" />
                    </span>
                    {liveFacts.length > 0 ? 'Answering from your memories…' : 'Thinking…'}
                  </p>
                )}
              </div>
            </Bubble>
          )}
          {offer && !liveQuestion && <ResearchOfferChip session={session} offer={offer} />}
          {failed && (
            <p role="alert" className="text-sm text-red-700">
              {failMessage ?? 'That answer didn’t come through. Try asking again.'}
            </p>
          )}
        </div>
        <form
          className="mt-4 flex shrink-0 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor="chat-input">
            Ask a question
          </label>
          <input
            id="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your commitments, decisions, people — or anything at all…"
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm transition-colors focus:border-brand-teal"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="rounded-md bg-brand-teal px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-teal-ink disabled:opacity-40"
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
