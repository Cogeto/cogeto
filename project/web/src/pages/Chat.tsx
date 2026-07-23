import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnswerSegment, ChatFactDto, ChatResearchOffer, ResearchRunDto } from '@cogeto/shared';
import { mapMarkersToCitations, mapUnsourcedMarkers, scanAnswer } from '@cogeto/shared';
import {
  askChat,
  fetchChatCaptureStatus,
  fetchChatMessages,
  fetchResearchRun,
  proposeResearch,
  rememberChatMessage,
} from '../api';
import type { Session } from '../auth/oidc';
import { ChatMarkdown } from '../components/ChatMarkdown';
import { CitationChip } from '../components/CitationChip';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { ResearchInline } from '../components/ResearchInline';
import { Shell } from '../components/Shell';
import { UnsourcedChip } from '../components/UnsourcedChip';

/**
 * Chat, reimagined as "Ask → Briefing" (P6.9, decision 0049): the question is a
 * heading; Cogeto answers as flush editorial prose along a teal evidence rail,
 * every claim carrying a provenance chip, and each answer closes with a "stands
 * on" manifest of exactly what it drew from — memory, web, or honestly-marked
 * model knowledge. Provenance is the surface's identity, not a chatbot skin.
 *
 * Citation grammar is `{{cite:<uuid>}}` plus `{{unsourced}}` (decisions
 * 0007/0046). Stored messages carry canonical tokens; live streaming text is
 * canonicalized here from the model's `[F#]`/`[U]` markers via the SSE sources
 * map, and every non-conforming token is stripped — no raw marker reaches screen.
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

  // The manifest is the unique set of sources the answer stands on, in first-cited
  // order, plus whether any claim came from unmarked model knowledge.
  const citedIds: string[] = [];
  let hasUnsourced = false;
  for (const segment of segments) {
    if (segment.kind === 'cite' && !citedIds.includes(segment.memoryId)) {
      citedIds.push(segment.memoryId);
    } else if (segment.kind === 'unsourced') {
      hasUnsourced = true;
    }
  }
  const factFor = (id: string): ChatFactDto | undefined => facts?.find((f) => f.memoryId === id);

  return (
    <div>
      <ChatMarkdown
        segments={segments}
        renderChip={(segment: Extract<AnswerSegment, { kind: 'cite' | 'unsourced' }>) =>
          segment.kind === 'unsourced' ? (
            <UnsourcedChip />
          ) : (
            <CitationChip
              session={session}
              memoryId={segment.memoryId}
              fact={factFor(segment.memoryId)}
              onOpen={onOpenMemory}
            />
          )
        }
      />
      {(citedIds.length > 0 || hasUnsourced) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-dashed border-slate-200 pt-3">
          <span className="font-mono text-[0.64rem] uppercase tracking-[0.12em] text-slate-400">
            Stands on
          </span>
          {citedIds.map((id) => (
            <CitationChip
              key={id}
              session={session}
              memoryId={id}
              fact={factFor(id)}
              onOpen={onOpenMemory}
            />
          ))}
          {hasUnsourced && <UnsourcedChip />}
        </div>
      )}
    </div>
  );
}

/**
 * The research offer (decision 0046): a one-tap bridge from a knowledge answer
 * into the EXISTING minimise-and-approve gate. Tapping proposes a run (nothing
 * is sent) and opens the gate right here in the conversation (decision 0047).
 */
function ResearchOfferChip({
  session,
  offer,
  onProposed,
}: {
  session: Session;
  offer: ChatResearchOffer;
  onProposed: (run: ResearchRunDto) => void;
}) {
  const propose = useMutation({
    mutationFn: () => proposeResearch(session, offer.topic),
    onSuccess: (run) => onProposed(run),
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => propose.mutate()}
        disabled={propose.isPending}
        className="rounded-full border border-brand-teal/40 bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-teal-ink transition-colors hover:bg-brand-teal/20 disabled:opacity-40 dark:text-brand-teal"
      >
        {propose.isPending ? 'Preparing…' : 'Research this on the web →'}
      </button>
      <span className="text-xs text-slate-400">
        {propose.isError
          ? 'Couldn’t prepare that research. Try the Research page.'
          : 'You’ll see and approve exactly what is sent. Nothing leaves until then.'}
      </span>
    </div>
  );
}

/**
 * "Remember this" on a user message (O2-C, decision 0021): routes the message
 * through the pipeline and polls capture progress. Only user messages get this.
 */
function RememberAction({ session, messageId }: { session: Session; messageId: string }) {
  const queryClient = useQueryClient();
  const [captured, setCaptured] = useState(false);
  const remember = useMutation({
    mutationFn: () => rememberChatMessage(session, messageId),
    onSuccess: () => setCaptured(true),
  });
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
        className="mt-1.5 font-mono text-[0.68rem] uppercase tracking-[0.08em] text-slate-400 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
        title="Remember this message. It becomes memory through the normal pipeline"
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
    <span
      className={`mt-1.5 block font-mono text-[0.68rem] uppercase tracking-[0.08em] ${
        state === 'failed'
          ? 'text-red-600 dark:text-red-300'
          : 'text-brand-teal-ink dark:text-brand-teal'
      }`}
    >
      {label}
    </span>
  );
}

/** The question as a confident heading (P6.9). */
function AskHeading({ time, children }: { time?: string; children: ReactNode }) {
  return (
    <div>
      <span className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-slate-400">
        You{time ? ` · ${time}` : ''}
      </span>
      <h2 className="mt-1.5 text-xl font-semibold leading-snug tracking-tight text-balance text-slate-800">
        {children}
      </h2>
    </div>
  );
}

/** The answer along the teal evidence rail (P6.9). */
function AnswerBlock({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 grid grid-cols-[3px_1fr] gap-5">
      <div
        className="rounded bg-gradient-to-b from-brand-teal to-brand-teal/25"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <span className="mb-2.5 inline-flex items-center gap-2 font-mono text-[0.68rem] uppercase tracking-[0.1em] text-brand-teal-ink dark:text-brand-teal">
          <span
            className="h-1.5 w-1.5 rounded-full bg-brand-teal shadow-[0_0_0_3px_var(--color-brand-teal-surface)] dark:shadow-[0_0_0_3px_rgba(33,194,154,0.15)]"
            aria-hidden="true"
          />
          Cogeto · from your memory
        </span>
        {children}
      </div>
    </div>
  );
}

function ThinkingDots({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-400">
      <span className="inline-flex gap-0.5" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal/70" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal/70 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal/70 [animation-delay:300ms]" />
      </span>
      {label}
    </p>
  );
}

/** Send glyph — inline SVG, no icon dependency. */
function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** The recurring Cogeto node mark for the composer. */
function CogetoMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <circle cx="12" cy="12" r="3.4" />
      <circle cx="12" cy="12" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

const SUGGESTED_PROMPTS = [
  'What did I promise this week?',
  'Summarise my open commitments',
  'What changed since last month?',
  'Who is involved in my active work?',
];

type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string };
type Turn = { key: string; question?: ChatMessage; answer?: ChatMessage };

/** Pair the alternating message stream into ask → briefing turns. */
function buildTurns(history: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const m = history[i];
    if (!m) continue;
    if (m.role === 'user') {
      const next = history[i + 1];
      if (next && next.role === 'assistant') {
        turns.push({ key: m.id, question: m, answer: next });
        i += 1;
      } else {
        turns.push({ key: m.id, question: m });
      }
    } else {
      turns.push({ key: m.id, answer: m });
    }
  }
  return turns;
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
  /** The inline research flow (0047): the SAME gate, embedded in the conversation. */
  const [inlineRun, setInlineRun] = useState<ResearchRunDto | null>(null);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Pin the view to the latest message: scroll the message pane itself (never
  // the page — the composer stays docked) on history and stream updates.
  useEffect(() => {
    const pane = scrollRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [history, liveText, liveQuestion, inlineRun]);

  // Auto-grow the composer up to a cap; collapses back when the draft is cleared.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const prefill = (text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  };

  const send = async (text?: string, opts: { suppressOffer?: boolean } = {}) => {
    const content = (text ?? draft).trim();
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
        else if (event.type === 'token') setLiveText((prev) => prev + event.text);
        else if (event.type === 'done') {
          // The concluding turn after research never re-offers research (0047).
          setOffer(opts.suppressOffer ? null : (event.researchOffer ?? null));
          // A research turn proposed a run: open the SAME gate inline. Nothing
          // has been sent — the run is loaded through the owner-gated research
          // endpoints, exactly as the Research page loads it.
          if (event.researchProposal) {
            void fetchResearchRun(session, event.researchProposal.runId)
              .then((run) => setInlineRun(run))
              .catch(() => setInlineRun(null));
          }
        } else if (event.type === 'error') {
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

  const turns = history ? buildTurns(history as ChatMessage[]) : [];
  const empty = !isPending && turns.length === 0 && !liveQuestion;

  return (
    <Shell session={session} title="Chat" active="chat" fullHeight>
      <section className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-2 py-4">
            {isPending && <p className="text-sm text-slate-400">Loading conversation…</p>}

            {empty && (
              <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
                <div className="grid h-14 w-14 place-items-center rounded-2xl border border-brand-teal/30 bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal">
                  <CogetoMark />
                </div>
                <div className="max-w-md">
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-800">
                    Ask your memory.
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">
                    Every answer shows, sentence by sentence, what Cogeto can prove, and honestly
                    marks what it can’t. The web is searched only when you ask and approve.
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTED_PROMPTS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => prefill(s)}
                      className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:border-brand-teal hover:text-brand-teal-ink dark:hover:text-brand-teal"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-10">
              {turns.map((turn) => (
                <article key={turn.key}>
                  {turn.question && (
                    <div>
                      <AskHeading>{turn.question.content}</AskHeading>
                      <RememberAction session={session} messageId={turn.question.id} />
                    </div>
                  )}
                  {turn.answer && (
                    <AnswerBlock>
                      <MessageBody
                        session={session}
                        content={turn.answer.content}
                        onOpenMemory={setOpenMemoryId}
                      />
                    </AnswerBlock>
                  )}
                </article>
              ))}

              {liveQuestion && (
                <article>
                  <AskHeading>{liveQuestion}</AskHeading>
                  <AnswerBlock>
                    <div aria-live="polite" aria-busy={!liveText}>
                      {liveText ? (
                        <MessageBody
                          session={session}
                          content={liveText}
                          facts={liveFacts}
                          onOpenMemory={setOpenMemoryId}
                        />
                      ) : (
                        <ThinkingDots
                          label={
                            liveFacts.length > 0 ? 'Answering from your memories…' : 'Thinking…'
                          }
                        />
                      )}
                    </div>
                  </AnswerBlock>
                </article>
              )}

              {inlineRun && (
                <ResearchInline
                  key={inlineRun.id}
                  session={session}
                  run={inlineRun}
                  onConclude={(topic) => {
                    setInlineRun(null);
                    void queryClient.invalidateQueries({ queryKey: ['research-runs'] });
                    void send(topic, { suppressOffer: true });
                  }}
                  onClose={() => {
                    setInlineRun(null);
                    void queryClient.invalidateQueries({ queryKey: ['research-runs'] });
                  }}
                />
              )}
              {offer && !liveQuestion && !inlineRun && (
                <ResearchOfferChip
                  session={session}
                  offer={offer}
                  onProposed={(run) => {
                    setOffer(null);
                    setInlineRun(run);
                  }}
                />
              )}
              {failed && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {failMessage ?? 'That answer didn’t come through. Try asking again.'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Docked command-bar composer */}
        <div className="shrink-0 pt-3">
          <div className="mx-auto max-w-3xl px-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="chat-input">
                Ask a question
              </label>
              <div className="flex items-end gap-2.5 rounded-2xl border border-slate-300 bg-surface px-4 py-2.5 shadow-sm transition-shadow focus-within:border-brand-teal focus-within:shadow-glow">
                <span className="self-center text-brand-teal" aria-hidden="true">
                  <CogetoMark />
                </span>
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  value={draft}
                  rows={1}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Ask your memory…"
                  className="max-h-40 flex-1 resize-none self-center bg-transparent py-1 text-[0.95rem] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
                />
                <button
                  type="submit"
                  disabled={busy || !draft.trim()}
                  aria-label="Send"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-teal text-white transition-transform hover:-translate-y-px hover:brightness-105 disabled:opacity-40"
                >
                  {busy ? (
                    <span
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                      aria-hidden="true"
                    />
                  ) : (
                    <SendIcon />
                  )}
                </button>
              </div>
              <p className="mt-2 text-center font-mono text-[0.66rem] tracking-[0.04em] text-slate-400">
                Enter to send · Shift+Enter for a new line · every claim shows what it can prove
              </p>
            </form>
          </div>
        </div>
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
