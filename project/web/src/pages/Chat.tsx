import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  AnswerSegment,
  ChatAttachmentDto,
  ChatFactDto,
  ChatResearchOffer,
  ResearchRunDto,
} from '@cogeto/shared';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  mapMarkersToCitations,
  mapUnsourcedMarkers,
  scanAnswer,
} from '@cogeto/shared';
import {
  askChat,
  createConversation,
  fetchChatCaptureStatus,
  fetchChatMessages,
  fetchConversationAttachments,
  fetchConversations,
  fetchResearchRun,
  fetchResearchRuns,
  proposeResearch,
  rememberChatMessage,
  uploadChatAttachment,
} from '../api';
import type { Session } from '../auth/oidc';
import { AttachmentCard, TransientMeaningLine } from '../components/AttachmentCard';
import { ChatMarkdown } from '../components/ChatMarkdown';
import { CitationChip } from '../components/CitationChip';
import { ConversationSidebar } from '../components/ConversationSidebar';
import {
  chatLink,
  conversationLabel,
  initialConversationId,
  parseChatLink,
} from '../components/conversations-model';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { ResearchInline } from '../components/ResearchInline';
import { pickResumeRun } from '../components/research-resume';
import { Shell } from '../components/Shell';
import { UnsourcedChip } from '../components/UnsourcedChip';
import { getAutoResearch, setAutoResearch } from '../research-pref';
import { validateUploadFile } from '../upload-validation';

/**
 * Chat, reimagined as "Ask → Briefing": the question is a
 * heading; Cogeto answers as flush editorial prose along a teal evidence rail,
 * every claim carrying a provenance chip, and each answer closes with a "stands
 * on" manifest of exactly what it drew from — memory, web, or honestly-marked
 * model knowledge. Provenance is the surface's identity, not a chatbot skin.
 *
 * Citation grammar is `{{cite:<uuid>}}` plus `{{unsourced}}` . Stored messages carry canonical tokens; live streaming text is
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
  const { t } = useTranslation('chat');
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
            {t('answer.standsOn')}
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
 * The research offer: a one-tap bridge from a knowledge answer
 * into the EXISTING minimise-and-approve gate. Tapping proposes a run (nothing
 * is sent) and opens the gate right here in the conversation.
 */
function ResearchOfferChip({
  session,
  offer,
  conversationId,
  onProposed,
}: {
  session: Session;
  offer: ChatResearchOffer;
  /** The invoking thread — the concluded answer lands there. */
  conversationId: string | null;
  onProposed: (run: ResearchRunDto) => void;
}) {
  const { t } = useTranslation('chat');
  const propose = useMutation({
    mutationFn: () => proposeResearch(session, offer.topic, conversationId ?? undefined),
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
        {propose.isPending ? t('researchOffer.preparing') : t('researchOffer.action')}
      </button>
      {propose.isError ? (
        <span className="text-xs text-slate-400">{t('researchOffer.error')}</span>
      ) : (
        <button
          type="button"
          onClick={() => {
            // "Don't ask again": from now on, research runs automatically — and
            // this one runs now too. Disable in Settings.
            setAutoResearch(true);
            propose.mutate();
          }}
          className="text-xs text-slate-400 underline underline-offset-2 transition-colors hover:text-slate-600"
          title={t('researchOffer.alwaysTitle')}
        >
          {t('researchOffer.always')}
        </button>
      )}
    </div>
  );
}

/**
 * "Remember this" on a user message: routes the message
 * through the pipeline and polls capture progress. Only user messages get this.
 */
function RememberAction({ session, messageId }: { session: Session; messageId: string }) {
  const { t } = useTranslation('chat');
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
        title={t('remember.title')}
      >
        {remember.isPending ? t('remember.pending') : t('remember.action')}
      </button>
    );
  }
  const state = status.data?.state ?? 'processing';
  const label =
    state === 'done'
      ? t('remember.done')
      : state === 'failed'
        ? t('remember.failed')
        : t('remember.working');
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

/** The question as a confident heading. */
/**
 * The reasoning channel (Part C of reasoning support): the model's own
 * deliberation, collapsed by default, streaming live while it thinks and
 * reopenable on a stored answer. Renders nothing when there is no thinking —
 * a non-reasoning model must leave no empty affordance.
 *
 * A CONTROLLED toggle, not a native <details>: a <summary> that is not a
 * direct child of its <details> makes the browser render its own "Details"
 * label and marker, which is exactly the unstyled artifact this replaces.
 * Styled as the answer rail's quieter sibling: the same grid-and-rail layout
 * and mono micro-label, a slate rail where the answer's is teal, the
 * ThinkingDots cascade (in slate) while deliberation streams, and the text
 * rendered through the SAME markdown renderer the answer uses.
 */
function ReasoningDisclosure({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const { segments } = scanAnswer(text, undefined);
  return (
    <div className="mb-3 grid grid-cols-[3px_1fr] gap-5">
      <div
        className={`rounded bg-gradient-to-b from-slate-300 to-slate-300/20 dark:from-slate-600 dark:to-slate-600/20 ${
          streaming ? 'animate-pulse' : ''
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 font-mono text-[0.68rem] uppercase tracking-[0.1em] text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
        >
          <svg
            viewBox="0 0 8 8"
            className={`h-2 w-2 fill-current transition-transform duration-200 ${
              open ? 'rotate-90' : ''
            }`}
            aria-hidden="true"
          >
            <path d="M2 0 L7 4 L2 8 Z" />
          </svg>
          {streaming ? t('reasoning.streaming') : t('reasoning.heading')}
          {streaming && (
            <span className="inline-flex gap-0.5" aria-hidden="true">
              <span className="h-1 w-1 animate-pulse rounded-full bg-slate-400" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-slate-400 [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-slate-400 [animation-delay:300ms]" />
            </span>
          )}
        </button>
        {open && (
          <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1 text-[0.8rem] leading-relaxed text-slate-500 dark:text-slate-400">
            <ChatMarkdown segments={segments} renderChip={() => null} />
          </div>
        )}
      </div>
    </div>
  );
}

function AskHeading({ time, children }: { time?: string; children: ReactNode }) {
  const { t } = useTranslation('chat');
  return (
    <div>
      <span className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-slate-400">
        {time ? t('answer.askedByAt', { time }) : t('role.you')}
      </span>
      <h2 className="mt-1.5 text-2xl font-semibold leading-snug tracking-tight text-balance text-slate-800">
        {children}
      </h2>
    </div>
  );
}

/** The answer along the teal evidence rail. */
function AnswerBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation('chat');
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
          {t('answer.attribution')}
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

/**
 * The starter prompts. Structural ids, not English content: the text is looked
 * up as `chat:suggestedPrompts.<id>` so a translated instance suggests
 * questions in the user's own language.
 */
const SUGGESTED_PROMPT_IDS = ['promisedThisWeek', 'openCommitments', 'changedSince', 'whoInvolved'];

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string | null;
};
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
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();

  // The conversation containers: the deep link (?c=) wins, else the
  // most recent conversation; a brand-new instance starts with none and the
  // first send creates one.
  const [link] = useState(() => parseChatLink(window.location.search));
  const [activeId, setActiveId] = useState<string | null>(link.conversationId);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(link.messageId);
  const { data: conversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => fetchConversations(session),
  });
  useEffect(() => {
    if (activeId !== null || !conversations) return;
    const initial = initialConversationId(conversations, link.conversationId);
    if (initial) setActiveId(initial);
  }, [activeId, conversations, link.conversationId]);

  const { data: page, isPending } = useQuery({
    queryKey: ['chat-messages', activeId],
    queryFn: () => fetchChatMessages(session, activeId!),
    enabled: activeId !== null,
  });
  const history = page?.items;

  // The conversation's attachments (V2.2 item 5.1): rendered as cards under
  // the message each was sent with; the cards poll their own state while the
  // pipeline runs.
  const { data: attachments } = useQuery({
    queryKey: ['chat-attachments', activeId],
    queryFn: () => fetchConversationAttachments(session, activeId!),
    enabled: activeId !== null,
  });
  const attachmentsByMessage = new Map<string, ChatAttachmentDto[]>();
  const unlinkedAttachments: ChatAttachmentDto[] = [];
  for (const item of attachments ?? []) {
    if (item.messageId === null) {
      unlinkedAttachments.push(item);
    } else {
      const list = attachmentsByMessage.get(item.messageId) ?? [];
      list.push(item);
      attachmentsByMessage.set(item.messageId, list);
    }
  }

  // A ?q= param prefills the box — the timeline's "Explain in chat" hand-off
  // lands here with the question ready to send (never auto-sent).
  const [draft, setDraft] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Specific failure copy: rate limit / daily budget / timeout. */
  const [failMessage, setFailMessage] = useState<string | null>(null);
  /** Thinking mode (issue #424): per device, default on. Off answers fast
   * with no deliberation and no disclosure. */
  const [thinkingOn, setThinkingOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cogeto-thinking') !== '0';
    } catch {
      return true;
    }
  });
  const toggleThinking = () => {
    setThinkingOn((prev) => {
      try {
        localStorage.setItem('cogeto-thinking', prev ? '0' : '1');
      } catch {
        // Preference simply resets next visit.
      }
      return !prev;
    });
  };
  /** The paperclip's staged file (V2.2 item 5.1): picked but not yet sent,
   * with its "don't remember this file" choice. Uploaded on send. */
  const [pendingFile, setPendingFile] = useState<{ file: File; transient: boolean } | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  /** The reasoning channel, streamed live (Part C): shown collapsed above the
   * answer, and nothing renders when the model does not think. */
  const [liveThinking, setLiveThinking] = useState('');
  const [liveFacts, setLiveFacts] = useState<ChatFactDto[]>([]);
  /** The latest answer's research offer (0046) — ephemeral, cleared on the next ask. */
  const [offer, setOffer] = useState<ChatResearchOffer | null>(null);
  // A skill run proposed from chat: the run view
  // owns the gate and the live progress — chat just hands over the handle.
  const [skillRunId, setSkillRunId] = useState<string | null>(null);
  /** The inline research flow (0047): the SAME gate, embedded in the conversation. */
  const [inlineRun, setInlineRun] = useState<ResearchRunDto | null>(null);
  /** Resume research that ran on without us: an approved run
   * still extracting, or a concluded one whose stored answer was never seen,
   * re-mounts the inline view — the response survives leaving the chat. */
  const resumedRef = useRef(false);
  const { data: researchRuns } = useQuery({
    queryKey: ['research-runs'],
    queryFn: () => fetchResearchRuns(session),
  });
  useEffect(() => {
    if (resumedRef.current || inlineRun || !researchRuns) return;
    const resume = pickResumeRun(researchRuns, new Date());
    if (resume) {
      resumedRef.current = true;
      setInlineRun(resume);
    }
  }, [researchRuns, inlineRun]);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The in-flight stream's abort handle: switching conversations detaches it. */
  const streamRef = useRef<AbortController | null>(null);

  // Pin the view to the latest message: scroll the message pane itself (never
  // the page — the composer stays docked) on history and stream updates.
  // A deep-linked message (?m=) wins once: scroll to it and highlight instead.
  useEffect(() => {
    if (focusMessageId && history) {
      const target = document.getElementById(`msg-${focusMessageId}`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('ring-2', 'ring-brand-teal/50', 'rounded-lg');
        window.setTimeout(
          () => target.classList.remove('ring-2', 'ring-brand-teal/50', 'rounded-lg'),
          2500,
        );
        setFocusMessageId(null);
        if (activeId) window.history.replaceState(null, '', chatLink(activeId));
        return;
      }
    }
    const pane = scrollRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [history, liveText, liveQuestion, inlineRun, focusMessageId, activeId]);

  // Keep the URL on the active conversation so reloads and links land right.
  useEffect(() => {
    if (activeId && !focusMessageId) window.history.replaceState(null, '', chatLink(activeId));
  }, [activeId, focusMessageId]);

  /** Switching threads: detach any live stream, clear live state, load
   * the target thread in place. The detached turn still lands server-side in
   * the conversation it was sent to. */
  const switchConversation = (id: string) => {
    if (id === activeId) return;
    streamRef.current?.abort();
    streamRef.current = null;
    setBusy(false);
    setLiveQuestion(null);
    setLiveText('');
    setLiveThinking('');
    setLiveFacts([]);
    setOffer(null);
    setInlineRun(null);
    setSkillRunId(null);
    setFailed(false);
    setFailMessage(null);
    setActiveId(id);
  };

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
    const staged = pendingFile;
    if ((!content && !staged) || busy) return;
    // The first send on an empty instance creates the conversation it lands in.
    let conversationId = activeId;
    if (!conversationId) {
      try {
        const created = await createConversation(session);
        conversationId = created.id;
        setActiveId(created.id);
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      } catch (error) {
        setFailed(true);
        setFailMessage(error instanceof Error ? error.message : null);
        return;
      }
    }
    setBusy(true);
    setFailed(false);
    setFailMessage(null);
    // The staged attachment uploads first (V2.2 item 5.1), so its id can ride
    // the ask and land under the message. The conversation is never blocked:
    // ingestion runs in the worker and the card reports the honest progress.
    let attachmentIds: string[] = [];
    if (staged) {
      try {
        const created = await uploadChatAttachment(
          session,
          staged.file,
          conversationId,
          staged.transient,
        );
        attachmentIds = [created.attachment.id];
        setPendingFile(null);
        setAttachError(null);
        void queryClient.invalidateQueries({ queryKey: ['chat-attachments', conversationId] });
      } catch (error) {
        // The message is NOT sent over a failed upload: the user decides
        // whether to retry, drop the file, or send the text alone.
        setBusy(false);
        setAttachError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (!content) {
      // An attachment-only send: nothing to ask, the card carries the rest.
      setBusy(false);
      return;
    }
    setDraft('');
    setLiveQuestion(content);
    setLiveText('');
    setLiveThinking('');
    setLiveFacts([]);
    setOffer(null);
    setSkillRunId(null);
    const controller = new AbortController();
    streamRef.current = controller;
    try {
      await askChat(
        session,
        content,
        conversationId,
        (event) => {
          if (event.type === 'sources') setLiveFacts(event.facts);
          else if (event.type === 'thinking') setLiveThinking((prev) => prev + event.text);
          else if (event.type === 'token') setLiveText((prev) => prev + event.text);
          else if (event.type === 'done') {
            if (event.skillRun) setSkillRunId(event.skillRun.runId);
            if (event.researchProposal) {
              // A research-class question already proposed a run: open it inline.
              setOffer(null);
              void fetchResearchRun(session, event.researchProposal.runId)
                .then((run) => setInlineRun(run))
                .catch(() => setInlineRun(null));
            } else {
              // A knowledge answer may offer research. With auto-research on
              // the tap is implicit: propose + run it immediately;
              // otherwise show the one-tap offer. (Concluding turns never re-offer.)
              const nextOffer = opts.suppressOffer ? null : (event.researchOffer ?? null);
              if (nextOffer && getAutoResearch()) {
                setOffer(null);
                void proposeResearch(session, nextOffer.topic, conversationId ?? undefined)
                  .then((run) => setInlineRun(run))
                  .catch(() => setOffer(nextOffer));
              } else {
                setOffer(nextOffer);
              }
            }
          } else if (event.type === 'error') {
            setFailed(true);
            // Specific copy for the daily budget / stream-timeout aborts.
            if (event.code === 'model_budget_exceeded' || event.code === 'timeout') {
              setFailMessage(event.message);
            }
          }
        },
        controller.signal,
        { thinking: thinkingOn, attachmentIds },
      );
    } catch (error) {
      // A detached stream (conversation switch) is intentional — not a failure.
      if (!controller.signal.aborted) {
        // A pre-stream 429 (rate limit / too many streams) throws with the
        // server's message; show it verbatim.
        setFailed(true);
        setFailMessage(error instanceof Error ? error.message : null);
      }
    }
    if (streamRef.current === controller) streamRef.current = null;
    if (controller.signal.aborted) return;
    await queryClient.invalidateQueries({ queryKey: ['chat-messages', conversationId] });
    // The sidebar's preview + recency move; the auto-title lands moments later
    // via the worker, picked up by the sidebar's refetch.
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    // The send linked its attachments to the stored message row.
    if (attachmentIds.length > 0) {
      void queryClient.invalidateQueries({ queryKey: ['chat-attachments', conversationId] });
    }
    setLiveQuestion(null);
    setLiveText('');
    setLiveThinking('');
    setLiveFacts([]);
    setBusy(false);
  };

  const turns = history ? buildTurns(history as ChatMessage[]) : [];
  const loading = activeId !== null && isPending;
  const empty = !loading && turns.length === 0 && !liveQuestion && (attachments?.length ?? 0) === 0;

  // The conversations sidebar rides the Shell's left
  // rail — OUTSIDE the header/content column, so the breadcrumb and the
  // thread center in the same remaining width and stay aligned.
  const conversationRail = (
    <div className="hidden min-h-0 md:flex">
      <ConversationSidebar
        session={session}
        activeId={activeId}
        onSelect={switchConversation}
        onCreated={(created) => switchConversation(created.id)}
        onDeleted={(deletedId) => {
          if (deletedId !== activeId) return;
          const remaining = (conversations ?? []).filter((c) => c.id !== deletedId);
          setActiveId(initialConversationId(remaining, null));
        }}
      />
    </div>
  );

  return (
    <Shell
      session={session}
      title={t('navigation:section.chat')}
      active="chat"
      fullHeight
      leftRail={conversationRail}
    >
      <section className="flex min-h-0 flex-1 flex-col">
        {/* Narrow screens: a compact picker in place of the sidebar column. */}
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 md:hidden">
          <label className="sr-only" htmlFor="conversation-picker">
            {t('conversation.pickerLabel')}
          </label>
          <select
            id="conversation-picker"
            value={activeId ?? ''}
            onChange={(e) => switchConversation(e.target.value)}
            className="min-w-0 flex-1 truncate rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-sm text-slate-700"
          >
            {(conversations ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {conversationLabel(c)}
                {c.archived ? t('conversation.archivedSuffix') : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              void createConversation(session).then((created) => {
                void queryClient.invalidateQueries({ queryKey: ['conversations'] });
                switchConversation(created.id);
              })
            }
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-600 hover:border-brand-teal hover:text-brand-teal-ink dark:hover:text-brand-teal"
          >
            {t('conversation.newShort')}
          </button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-4">
            {loading && <p className="text-sm text-slate-400">{t('loadingConversation')}</p>}

            {empty && (
              <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
                <div className="grid h-14 w-14 place-items-center rounded-2xl border border-brand-teal/30 bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal">
                  <CogetoMark />
                </div>
                <div className="max-w-md">
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-800">
                    {t('empty.title')}
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">{t('empty.body')}</p>
                  <p className="mt-2 text-xs leading-relaxed text-slate-400">
                    {t('empty.workspaceNote')}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTED_PROMPT_IDS.map((id) => {
                    const prompt = t(`suggestedPrompts.${id}`);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => prefill(prompt)}
                        className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:border-brand-teal hover:text-brand-teal-ink dark:hover:text-brand-teal"
                      >
                        {prompt}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-10">
              {turns.map((turn) => (
                <article key={turn.key}>
                  {turn.question && (
                    <div id={`msg-${turn.question.id}`}>
                      <AskHeading>{turn.question.content}</AskHeading>
                      {(attachmentsByMessage.get(turn.question.id) ?? []).map((item) => (
                        <AttachmentCard key={item.id} session={session} attachment={item} />
                      ))}
                      <RememberAction session={session} messageId={turn.question.id} />
                    </div>
                  )}
                  {turn.answer && (
                    <div id={`msg-${turn.answer.id}`}>
                      <AnswerBlock>
                        {turn.answer.thinking && (
                          <ReasoningDisclosure text={turn.answer.thinking} />
                        )}
                        <MessageBody
                          session={session}
                          content={turn.answer.content}
                          onOpenMemory={setOpenMemoryId}
                        />
                      </AnswerBlock>
                    </div>
                  )}
                </article>
              ))}

              {unlinkedAttachments.length > 0 && (
                <article>
                  {unlinkedAttachments.map((item) => (
                    <AttachmentCard key={item.id} session={session} attachment={item} />
                  ))}
                </article>
              )}

              {liveQuestion && (
                <article>
                  <AskHeading>{liveQuestion}</AskHeading>
                  <AnswerBlock>
                    {liveThinking && (
                      <ReasoningDisclosure text={liveThinking} streaming={!liveText} />
                    )}
                    <div aria-live="polite" aria-busy={!liveText}>
                      {liveText ? (
                        <MessageBody
                          session={session}
                          content={liveText}
                          facts={liveFacts}
                          onOpenMemory={setOpenMemoryId}
                        />
                      ) : liveThinking ? null : (
                        <ThinkingDots
                          label={
                            liveFacts.length > 0
                              ? t('thinking.fromMemories')
                              : t('thinking.default')
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
                  onClose={() => {
                    setInlineRun(null);
                    void queryClient.invalidateQueries({ queryKey: ['research-runs'] });
                  }}
                />
              )}
              {skillRunId && !liveQuestion && (
                <a
                  href={`/skills?run=${encodeURIComponent(skillRunId)}`}
                  className="inline-flex items-center gap-2 rounded-full border border-brand-teal/40 bg-brand-teal/10 px-3.5 py-1.5 text-sm font-medium text-brand-teal-ink transition-colors hover:bg-brand-teal/20 dark:text-brand-teal"
                >
                  {t('skillRunHandoff')}
                </a>
              )}
              {offer && !liveQuestion && !inlineRun && (
                <ResearchOfferChip
                  session={session}
                  offer={offer}
                  conversationId={activeId}
                  onProposed={(run) => {
                    setOffer(null);
                    setInlineRun(run);
                  }}
                />
              )}
              {failed && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {failMessage ?? t('answerFailed')}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Docked command-bar composer */}
        <div className="shrink-0 pt-3">
          <div className="mx-auto max-w-3xl px-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="chat-input">
                {t('composer.label')}
              </label>
              {pendingFile && (
                <div className="mb-2 space-y-1 rounded-xl border border-slate-200 bg-surface px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="truncate font-medium text-slate-700">
                      {pendingFile.file.name}
                    </span>
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={pendingFile.transient}
                        onChange={(e) =>
                          setPendingFile({ file: pendingFile.file, transient: e.target.checked })
                        }
                      />
                      {t('attachment.transientToggle')}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingFile(null);
                        setAttachError(null);
                      }}
                      className="ml-auto text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
                    >
                      {t('attachment.removeStaged')}
                    </button>
                  </div>
                  {pendingFile.transient ? (
                    <TransientMeaningLine />
                  ) : (
                    <p className="text-xs leading-relaxed text-slate-400">
                      {t('attachment.durableHint')}
                    </p>
                  )}
                </div>
              )}
              {attachError && (
                <p role="alert" className="mb-2 text-xs text-red-700 dark:text-red-300">
                  {attachError}
                </p>
              )}
              <div className="flex items-end gap-2.5 rounded-2xl border border-slate-300 bg-surface px-4 py-2.5 shadow-sm transition-shadow focus-within:border-brand-teal focus-within:shadow-glow">
                <span className="self-center text-brand-teal" aria-hidden="true">
                  <CogetoMark />
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ALLOWED_UPLOAD_EXTENSIONS.join(',')}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ''; // allow re-selecting the same file
                    if (!file) return;
                    const problem = validateUploadFile(file);
                    if (problem) {
                      setAttachError(problem);
                      return;
                    }
                    setAttachError(null);
                    setPendingFile({ file, transient: false });
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t('attachment.attachLabel')}
                  title={t('attachment.attachLabel')}
                  className="grid h-8 w-8 shrink-0 select-none place-items-center self-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700/40"
                >
                  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                    <path
                      d="M13.8 8.2 8.9 13.1a2.4 2.4 0 0 1-3.4-3.4l5.6-5.6a3.6 3.6 0 0 1 5.1 5.1l-6 6a4.8 4.8 0 0 1-6.8-6.8l5.3-5.3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
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
                  placeholder={t('composer.placeholder')}
                  className="max-h-40 flex-1 resize-none self-center bg-transparent py-1 text-[0.95rem] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
                />
                <button
                  type="submit"
                  disabled={busy || (!draft.trim() && !pendingFile)}
                  aria-label={t('composer.send')}
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
              <div className="mt-2 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={toggleThinking}
                  aria-pressed={thinkingOn}
                  className={`rounded-full border px-2 py-0.5 font-mono text-[0.66rem] tracking-[0.04em] transition-colors ${
                    thinkingOn
                      ? 'border-brand-teal text-brand-teal-ink dark:text-brand-teal'
                      : 'border-slate-300 text-slate-400'
                  }`}
                >
                  {thinkingOn ? t('reasoning.toggleOn') : t('reasoning.toggleOff')}
                </button>
                <p className="text-center font-mono text-[0.66rem] tracking-[0.04em] text-slate-400">
                  {t('composer.hint')}
                </p>
              </div>
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
