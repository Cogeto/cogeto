import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  ChatContextDto,
  ChatFactDto,
  ChatMessagePage,
  ChatRememberedDto,
  ChatStreamEvent,
  ConversationDto,
  NoteProcessingState,
  Principal,
} from '@cogeto/shared';
import {
  buildContextBlock,
  deadLetter,
  DEFAULT_INSTANCE_TIMEZONE,
  DRIZZLE,
  EMPTY_USER_CONTEXT,
  hasProfileContext,
  INSTANCE_TIMEZONE,
  jobExecution,
  UserContextService,
  withTransactionalEnqueue,
} from '../../infrastructure/index';
import type { Db, UserContextRecord } from '../../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../../ingestion/index';
import { isPastBelief } from '../../memory/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { UserDirectory } from '../../identity/index';
import { RetrievalService } from '../retrieval.service';
import type { RetrievedMemory } from '../retrieval.service';
import type { ConversationTurn, SmallTalkIntent } from '../query-rewrite';
import {
  ANAPHORA_RE,
  detectResearchIntent,
  detectSkillBriefIntent,
  detectSmallTalk,
  rewriteQuery,
} from '../query-rewrite';
import { queryEntityCandidates } from '../query-entities';
import { CHAT_REPLY_RESOLVER } from './chat-reply-resolver.port';
import type { ChatReplyResolverPort } from './chat-reply-resolver.port';
import { CHAT_RESEARCH_RESOLVER } from './chat-research-resolver.port';
import type { ChatResearchResolverPort } from './chat-research-resolver.port';
import { CHAT_SKILL_RESOLVER } from './chat-skill-resolver.port';
import type { ChatSkillResolverPort } from './chat-skill-resolver.port';
import { chatMessage, conversation } from '../persistence/tables';
import type { ConversationRow } from '../persistence/tables';
import { CONVERSATION_TITLE_JOB_TYPE } from './conversation-titler';
import {
  ANSWER_PROMPT,
  buildAnswerInput,
  buildSmallTalkInput,
  nothingOnRecord,
  nothingOpen,
  toStoredAnswer,
} from './answer-prompt';

/** How many facts the answer context receives (wider so aggregation fits, F5). */
const ANSWER_FACTS_TOP_K = 12;
/** How much history the chat page loads per request (the default page size). */
const HISTORY_LIMIT = 200;
/** Turns of prior conversation the rewriter sees to resolve references (F3).
 * Per conversation since — another thread's raw turns never enter. */
const REWRITE_HISTORY_TURNS = 6;
/** Active (non-archived) conversations per user: keeps
 * the sidebar renderable and nudges archiving; archived ones are unlimited. */
const MAX_ACTIVE_CONVERSATIONS = 100;
/** Sidebar preview length — first characters of the last message. */
const PREVIEW_CHARS = 120;

/** Surrounding turns shown either side of a remembered message in its drawer. */
const CONTEXT_TURNS = 2;

/** The per-turn user context: record + effective tz + rendered blocks. */
interface AskContext {
  record: UserContextRecord;
  timeZone: string;
  rewriteBlock: string;
  answerBlock: string;
}

/**
 * The chat area. Asking a question is strictly fast path (§A.3): persist
 * → retrieve → generate — deliberately NO enqueue and no ingestion-stage work.
 *
 * Capture is separate and explicit: `rememberMessage` routes a
 * USER message through the normal pipeline (source_type 'chat'). The persisted
 * chat_message rows are those memories' §A.6 provenance targets. The assistant's
 * own replies are never captured.
 */
@Injectable()
export class ChatService {
  private prompt?: PromptArtifact;
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly retrieval: RetrievalService,
    private readonly gateway: ModelGateway,
    private readonly directory: UserDirectory,
    /** The chat → email-reply seam. Absent in the worker and bare
     * test harnesses — then the reply intent is simply inactive. */
    @Optional() @Inject(CHAT_REPLY_RESOLVER) private readonly replyResolver?: ChatReplyResolverPort,
    /** The chat → research seam. Absent in the worker —
     * then the research intent is simply inactive. */
    @Optional()
    @Inject(CHAT_RESEARCH_RESOLVER)
    private readonly researchResolver?: ChatResearchResolverPort,
    // Instance timezone for the router's precomputed rewrite (parity
    // with retrieval's own rewriter call).
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly timeZone: string = DEFAULT_INSTANCE_TIMEZONE,
    /** Per-user context + language. Absent in bare test harnesses —
     * then the defaults apply (instance timezone, English, no profile). */
    @Optional()
    private readonly userContext?: UserContextService,
    /** The chat → skill seam. Appended LAST so
     * positional harness constructions keep working; absent in the worker —
     * then the brief intent is simply inactive. */
    @Optional()
    @Inject(CHAT_SKILL_RESOLVER)
    private readonly skillResolver?: ChatSkillResolverPort,
  ) {}

  /**
   * The sidebar's conversation list: the caller's own conversations,
   * newest activity first, each with the last-message preview. Owner-gated by
   * construction — the WHERE clause is the gate, like every chat query.
   */
  async listConversations(principal: Principal): Promise<ConversationDto[]> {
    const rows = await this.db
      .select()
      .from(conversation)
      .where(eq(conversation.ownerId, principal.userId))
      .orderBy(desc(conversation.updatedAt), desc(conversation.id));
    // Last message per conversation in one pass (DISTINCT ON) — the preview.
    const previews = await this.db.execute(sql`
      SELECT DISTINCT ON (conversation_id) conversation_id, content
      FROM chat_message
      WHERE owner_id = ${principal.userId}
      ORDER BY conversation_id, created_at DESC, id DESC
    `);
    const previewByConversation = new Map(
      (previews.rows as { conversation_id: string; content: string }[]).map((r) => [
        r.conversation_id,
        r.content,
      ]),
    );
    return rows.map((row) => toConversationDto(row, previewByConversation.get(row.id) ?? null));
  }

  /** A new, untitled conversation — the sidebar's "New conversation" action. */
  async createConversation(principal: Principal): Promise<ConversationDto> {
    const active = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversation)
      .where(and(eq(conversation.ownerId, principal.userId), eq(conversation.archived, false)));
    if ((active[0]?.count ?? 0) >= MAX_ACTIVE_CONVERSATIONS) {
      throw new BadRequestException(
        `you have ${MAX_ACTIVE_CONVERSATIONS} active conversations — archive or delete some first`,
      );
    }
    const [row] = await this.db
      .insert(conversation)
      .values({ ownerId: principal.userId })
      .returning();
    return toConversationDto(row!, null);
  }

  /** Manual rename — wins forever: the auto-titler never overwrites it. */
  async renameConversation(
    principal: Principal,
    conversationId: string,
    title: string,
  ): Promise<ConversationDto> {
    await this.requireConversation(principal, conversationId);
    const [row] = await this.db
      .update(conversation)
      .set({ title, titleSetByUser: true })
      .where(eq(conversation.id, conversationId))
      .returning();
    return toConversationDto(row!, null);
  }

  /** Archive / unarchive — the safe alternative to deletion: everything kept,
   * memories stay retrievable; the thread just leaves the active list. */
  async setConversationArchived(
    principal: Principal,
    conversationId: string,
    archived: boolean,
  ): Promise<ConversationDto> {
    await this.requireConversation(principal, conversationId);
    const [row] = await this.db
      .update(conversation)
      .set({ archived })
      .where(eq(conversation.id, conversationId))
      .returning();
    return toConversationDto(row!, null);
  }

  /**
   * Messages of ONE conversation, ascending. Paged newest-first under the
   * house limit/offset style: offset 0 is the latest window (the page the chat
   * opens on); items within a page are returned oldest-first for display.
   */
  async listMessages(
    principal: Principal,
    conversationId: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<ChatMessagePage> {
    await this.requireConversation(principal, conversationId);
    const limit = page.limit ?? HISTORY_LIMIT;
    const offset = page.offset ?? 0;
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(chatMessage)
        .where(eq(chatMessage.conversationId, conversationId))
        .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(chatMessage)
        .where(eq(chatMessage.conversationId, conversationId)),
    ]);
    return {
      items: rows.reverse().map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
      })),
      total: totalRows[0]?.count ?? 0,
    };
  }

  /**
   * "Remember this": route a USER message through the normal
   * pipeline (source_type 'chat', source_id = message id). Transactional via the
   * outbox (§A.3), idempotency-keyed so a double-click captures at most once. The
   * assistant's replies are refused — its output is not evidence about the world.
   */
  async rememberMessage(principal: Principal, messageId: string): Promise<ChatRememberedDto> {
    const rows = await this.db
      .select()
      .from(chatMessage)
      .where(and(eq(chatMessage.id, messageId), eq(chatMessage.ownerId, principal.userId)))
      .limit(1);
    const message = rows[0];
    if (!message) throw new NotFoundException(`message ${messageId} not found`);
    if (message.role !== 'user') {
      throw new BadRequestException(
        'only your own messages can be remembered — the assistant’s replies are never captured',
      );
    }
    await this.db.transaction((tx) =>
      withTransactionalEnqueue(
        tx,
        {
          type: 'chat.remembered',
          payload: { source_type: 'chat', source_id: messageId, owner_id: principal.userId },
        },
        {
          type: INGESTION_PIPELINE_JOB_TYPE,
          payload: { source_type: 'chat', source_id: messageId },
        },
      ),
    );
    return { messageId };
  }

  /** Pipeline progress for the capture indicator — the queue's own ledgers
   * (mirror of NotesService.getProcessingState), owner-checked. */
  async captureState(principal: Principal, messageId: string): Promise<NoteProcessingState> {
    const owned = await this.db
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(and(eq(chatMessage.id, messageId), eq(chatMessage.ownerId, principal.userId)))
      .limit(1);
    if (owned.length === 0) throw new NotFoundException(`message ${messageId} not found`);

    const done = await this.db
      .select({ id: jobExecution.id })
      .from(jobExecution)
      .where(
        and(
          eq(jobExecution.sourceType, 'chat'),
          eq(jobExecution.sourceId, messageId),
          eq(jobExecution.jobType, INGESTION_PIPELINE_JOB_TYPE),
        ),
      )
      .limit(1);
    if (done.length > 0) return 'done';

    const failed = await this.db
      .select({ id: deadLetter.id })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.jobType, INGESTION_PIPELINE_JOB_TYPE),
          sql`${deadLetter.payload}->>'source_id' = ${messageId}`,
        ),
      )
      .limit(1);
    return failed.length > 0 ? 'failed' : 'processing';
  }

  /**
   * The chat context behind a remembered memory's source drawer
   * the message plus a couple of surrounding turns, owner-scoped, framed so the
   * provenance reads as a conversation rather than a note body.
   */
  async messageContext(principal: Principal, messageId: string): Promise<ChatContextDto> {
    const rows = await this.db
      .select()
      .from(chatMessage)
      .where(and(eq(chatMessage.id, messageId), eq(chatMessage.ownerId, principal.userId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw new NotFoundException(`message ${messageId} not found`);

    // Surrounding turns come from the SAME conversation only — the
    // drawer's framing must never blend another thread's turns in.
    const before = await this.db
      .select()
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, target.conversationId),
          lte(chatMessage.createdAt, target.createdAt),
        ),
      )
      .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
      .limit(CONTEXT_TURNS + 1);
    const after = await this.db
      .select()
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, target.conversationId),
          gte(chatMessage.createdAt, target.createdAt),
        ),
      )
      .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id))
      .limit(CONTEXT_TURNS + 1);

    const byId = new Map([...before, ...after].map((r) => [r.id, r]));
    const turns = [...byId.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.createdAt.toISOString(),
        isTarget: r.id === target.id,
      }));
    const conversationRows = await this.db
      .select({ title: conversation.title })
      .from(conversation)
      .where(eq(conversation.id, target.conversationId))
      .limit(1);
    return {
      turns,
      conversationId: target.conversationId,
      conversationTitle: conversationRows[0]?.title ?? null,
    };
  }

  /**
   * One question → one SSE stream: sources first (the frontend builds its
   * citation map before tokens arrive), then token deltas, then done with the
   * stored form of the answer.
   *
   * Routing (amended by 0060) — one router, all capabilities,
   * in this order: deterministic guards first (small-talk lexicon, skill
   * brief, research), then ONE bounded pipeline-tier call (the rewriter, now
   * also the classifier) whose result routes model-classified small talk, the reply
   * intent (with resolved anaphora), and the memory/knowledge answer paths.
   * Classification failure falls back to the memory-question path.
   */
  async *ask(
    principal: Principal,
    content: string,
    conversationId: string,
  ): AsyncGenerator<ChatStreamEvent> {
    // The conversation resolves FIRST (owner-gated, 404 otherwise): a message
    // always lands in the conversation it was sent to, even if the
    // client switches threads mid-stream.
    await this.requireConversation(principal, conversationId);
    // The user's context: timezone, profile, language — one PK read,
    // shaping every model call and deterministic reply in this turn.
    const ctx = await this.loadAskContext(principal);
    // Prior turns (before this one) feed the conversational rewriter (F3) —
    // from the CURRENT conversation only: cross-thread continuity is
    // memory retrieval's job, never raw turn context.
    const history = await this.recentTurns(conversationId);
    const [userRow] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, conversationId, role: 'user', content })
      .returning();
    await this.touchConversation(conversationId, userRow!.createdAt);

    // Small talk, deterministic: a pure pleasantry gets a
    // natural reply — no retrieval, no model call, no citation theatre.
    const smallTalk = detectSmallTalk(content);
    if (smallTalk) {
      yield* this.handleSmallTalk(principal, conversationId, smallTalk);
      return;
    }

    // Skill-brief intent: checked BEFORE the
    // research patterns so "research X before Thursday" becomes a brief, not
    // a plain search. This turn only starts PLANNING (gather + propose
    // queries); nothing leaves until the plan is approved on the run view.
    if (this.skillResolver) {
      const brief = detectSkillBriefIntent(content);
      if (brief) {
        yield* this.handleSkillBriefIntent(principal, conversationId, brief.subject, brief.lang);
        return;
      }
    }

    // Research intent: deterministic,
    // explicitly invoked — an imperative research verb, never an ordinary
    // question. This turn only OPENS the gate (minimise + record a proposed
    // run); NOTHING is sent until the user approves on the Research page.
    // A topic leaning on earlier turns ("research her company") resolves
    // through the rewriter first.
    if (this.researchResolver) {
      const research = detectResearchIntent(content);
      if (research) {
        let topic = research.topic;
        if (ANAPHORA_RE.test(topic) && queryEntityCandidates(topic).length === 0) {
          const resolved = await this.routerRewrite(history, topic, {}, ctx);
          if (
            queryEntityCandidates(resolved.query).length > 0 ||
            !ANAPHORA_RE.test(resolved.query)
          ) {
            topic = resolved.query;
          }
        }
        yield* this.handleResearchIntent(principal, conversationId, topic, research.lang);
        return;
      }
    }

    // The router call: ONE bounded pipeline-tier call rewrites
    // the turn AND classifies it. Failure/timeout falls back to the raw query
    // with class 'personal' — the memory-question path.
    const rewrite = await this.routerRewrite(history, content, { alwaysClassify: true }, ctx);

    // Model-classified small talk / meta (beyond the lexicon): a natural,
    // brief answer-tier reply — still no retrieval.
    if (rewrite.questionClass === 'smalltalk') {
      yield* this.handleModelSmallTalk(
        principal,
        conversationId,
        content,
        history,
        ctx.answerBlock,
      );
      return;
    }

    // Draft-a-reply intent: deterministic detection on the raw
    // turn; the router's resolved entities let "draft a reply to her last
    // email" reach the right sender. If the resolver is wired, this turn
    // creates an email reply draft (or asks / declines) — fast path, no
    // ingestion work, no sending. Then we return.
    if (this.replyResolver && rewrite.emailReply) {
      yield* this.handleReplyIntent(principal, conversationId, rewrite.emailReply.target);
      return;
    }

    // Memory-first: retrieval runs for BOTH personal and
    // knowledge questions — grounded facts always come first; general
    // knowledge supplements, marked, never replaces.
    const knowledge = rewrite.questionClass === 'knowledge';
    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
      history,
      rewrite,
    });
    const facts = retrieved.memories.map((hit, i) => toFactDto(hit, i));
    // Attribute cited shared facts to their owner — name-only; the gates
    // already decided these were visible to the caller.
    const names = await this.directory.displayNames(facts.map((f) => f.ownerId));
    for (const fact of facts) fact.ownerName = names.get(fact.ownerId) ?? null;
    yield { type: 'sources', facts };

    let answer: string;
    if (retrieved.mode === 'open_loops' && (retrieved.openLoops?.length ?? 0) === 0) {
      // Zero open loops is an ANSWER (all clear), not a data gap. A
      // deterministic string cannot mirror; it follows the anchor (0052).
      answer = nothingOpen(ctx.record.preferredLanguage);
      yield { type: 'token', text: answer };
    } else if (facts.length === 0 && !knowledge && !hasProfileContext(ctx.record)) {
      // The zero-retrieval path: no model call, no generation from thin air.
      // With profile context set, the model DOES answer: the
      // settings are provided ground ("where do I work?" deserves the honest
      // "you've set … in Settings" reply), the honest-gap rules still hold,
      // and the sanitizer still strips any invented citation.
      answer = nothingOnRecord(ctx.record.preferredLanguage);
      yield { type: 'token', text: answer };
    } else {
      const prompt = await this.getPrompt();
      let buffer = '';
      const stream = this.gateway.completeStream({
        system: prompt.content,
        input: buildAnswerInput(facts, content, retrieved.mode, {
          temporal: retrieved.temporal,
          changes: retrieved.changes,
          openLoops: retrieved.openLoops,
          knowledge,
          context: ctx.answerBlock,
        }),
        tier: 'answer',
      });
      for await (const text of stream) {
        buffer += text;
        yield { type: 'token', text };
      }
      answer = buffer;
    }

    const { text: stored, violations } = toStoredAnswer(answer, facts);
    if (violations > 0) {
      // Metadata only — never the answer content or tokens (pino rule).
      this.logger.warn(`citation_violation stripped=${violations}`);
    }
    const row = await this.storeAssistant(principal, conversationId, stored);
    // The research offer: every knowledge-class answer OFFERS
    // research as a one-tap bridge into the existing gate — never a silent
    // search. The offer carries the self-contained topic; tapping it proposes.
    const researchOffer = knowledge && this.researchResolver ? { topic: rewrite.query } : null;
    yield {
      type: 'done',
      messageId: row.id,
      content: stored,
      citationViolations: violations,
      researchOffer,
    };
  }

  /** The router's bounded rewrite call — shared fallback semantics (0046).
   * With an ask context, dates resolve against the USER's timezone and
   * the rewriter input carries the now-block. */
  private routerRewrite(
    history: ConversationTurn[],
    question: string,
    options: { alwaysClassify?: boolean } = {},
    ctx?: AskContext,
  ) {
    return rewriteQuery(
      this.gateway,
      history,
      question,
      undefined,
      undefined,
      ctx?.timeZone ?? this.timeZone,
      { ...options, contextBlock: ctx?.rewriteBlock },
    );
  }

  /**
   * The per-turn user context: the stored record (or the defaults when
   * the service is absent or the user never set anything), the effective
   * timezone (user override, else instance), and the two rendered now-blocks —
   * with the LANGUAGE rule for answer-tier calls, without it for the rewriter
   * (whose output is JSON, not prose).
   */
  private async loadAskContext(principal: Principal): Promise<AskContext> {
    let record: UserContextRecord = EMPTY_USER_CONTEXT;
    try {
      record = (await this.userContext?.get(principal.userId)) ?? EMPTY_USER_CONTEXT;
    } catch {
      // Context is an enhancement, never a gate: any read failure means the
      // turn proceeds exactly as before.
    }
    const timeZone = record.timezone ?? this.timeZone;
    const now = new Date();
    return {
      record,
      timeZone,
      rewriteBlock: buildContextBlock(record, now, timeZone),
      answerBlock: buildContextBlock(record, now, timeZone, { language: true }),
    };
  }

  /**
   * Deterministic small talk: a natural, brief reply in the
   * matched language. No retrieval, no model call, no citations"thanks!"
   * never earns a source chip or a "nothing on record".
   */
  private async *handleSmallTalk(
    principal: Principal,
    conversationId: string,
    intent: SmallTalkIntent,
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    const hr = intent.lang === 'hr';
    const replies: Record<SmallTalkIntent['kind'], string> = hr
      ? {
          thanks: 'Nema na čemu — drago mi je da je pomoglo.',
          greeting: 'Bok! Kako mogu pomoći?',
          farewell: 'Pozdrav — tu sam kad zatrebaš.',
          ack: 'Super. Mogu li još s čime pomoći?',
        }
      : {
          thanks: 'You’re welcome — glad it helped.',
          greeting: 'Hi! What can I help you with?',
          farewell: 'Take care — I’ll be here when you need me.',
          ack: 'Great. Anything else I can help with?',
        };
    const answer = replies[intent.kind];
    yield { type: 'token', text: answer };
    const row = await this.storeAssistant(principal, conversationId, answer);
    yield { type: 'done', messageId: row.id, content: answer, citationViolations: 0 };
  }

  /**
   * Model-classified small talk / meta: pleasantries and
   * questions about Cogeto itself that the lexicon does not cover ("what can
   * you do?"). A brief answer-tier reply with the recent turns for tone — no
   * retrieval, and the sanitizer still guarantees no marker can leak.
   */
  private async *handleModelSmallTalk(
    principal: Principal,
    conversationId: string,
    content: string,
    history: ConversationTurn[],
    contextBlock?: string,
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    const prompt = await this.getPrompt();
    let buffer = '';
    const stream = this.gateway.completeStream({
      system: prompt.content,
      input: buildSmallTalkInput(history, content, contextBlock),
      tier: 'answer',
    });
    for await (const text of stream) {
      buffer += text;
      yield { type: 'token', text };
    }
    const { text: stored, violations } = toStoredAnswer(buffer, []);
    if (violations > 0) {
      this.logger.warn(`citation_violation stripped=${violations}`);
    }
    const row = await this.storeAssistant(principal, conversationId, stored);
    yield { type: 'done', messageId: row.id, content: stored, citationViolations: violations };
  }

  /**
   * The draft-a-reply chat flow. Resolve the target email against
   * the owner's recent emails, then act like a thoughtful assistant
   *  - 0 matches      → say so, point to the drawer's "Draft reply".
   *  - >1 for a NAMED target → list the candidates and ask which (create nothing).
   *  - 1 (or "the last one") → create the draft via the approval path and confirm
   *    with a link. Cogeto never sends. No retrieval-answer, no ingestion work.
   */
  /**
   * The research gate opener: minimise the query and record a PROPOSED run —
   * the deterministic confirmation states plainly that nothing has been sent
   * and points at the Research page, where the user edits/approves/cancels.
   * The confirmation is deterministic text except the disclosed query itself.
   */
  private async *handleResearchIntent(
    principal: Principal,
    conversationId: string,
    topic: string,
    lang: 'en' | 'hr',
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    let answer: string;
    // The inline gate's handle: lets the chat surface open the
    // SAME gate in place. Null when proposing failed.
    let proposalRef: { runId: string } | null = null;
    try {
      const proposal = await this.researchResolver!.propose(principal, topic, conversationId);
      proposalRef = { runId: proposal.runId };
      answer =
        lang === 'hr'
          ? `Pripremio sam upit za istraživanje — ništa još nije poslano. ` +
            `Predloženi upit: "${proposal.minimisedQuery}" (${proposal.minimiseReason}) ` +
            `Uredi ili odobri upit ovdje u razgovoru (ili kasnije na stranici Research). ` +
            `tek tada išta napušta ovu instancu.`
          : `I've prepared a research query — nothing has been sent yet. ` +
            `Proposed query: "${proposal.minimisedQuery}" (${proposal.minimiseReason}) ` +
            `Edit or approve it right here in the conversation (or later from the Research page). ` +
            `only what you approve leaves this instance.`;
    } catch (error) {
      this.logger.warn(
        `research_intent_failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      answer =
        lang === 'hr'
          ? `Trenutno ne mogu pripremiti istraživanje. Pokušaj ponovno sa stranice Research.`
          : `I couldn't set up that research just now. Try again from the Research page.`;
    }
    yield { type: 'token', text: answer };
    const row = await this.storeAssistant(principal, conversationId, answer);
    yield {
      type: 'done',
      messageId: row.id,
      content: answer,
      citationViolations: 0,
      researchProposal: proposalRef,
    };
  }

  /**
   * The skill-brief opener: start planning —
   * gather from memory, propose the query plan — and hand the user the run
   * view, where the plan gate lives. Deterministic confirmation text; an
   * ambiguous subject asks and creates nothing.
   */
  private async *handleSkillBriefIntent(
    principal: Principal,
    conversationId: string,
    subject: string,
    lang: 'en' | 'hr',
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    let answer: string;
    let runRef: { runId: string } | null = null;
    try {
      const proposal = await this.skillResolver!.propose(principal, subject);
      if (proposal.status === 'ambiguous') {
        const list = proposal.candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
        answer =
          lang === 'hr'
            ? `Na koga točno misliš? Poznajem više njih:\n\n${list}\n\nReci puno ime i pripremit ću brief.`
            : `Which one do you mean? I know more than one:\n\n${list}\n\nTell me the full name and I'll prepare the brief.`;
      } else {
        runRef = { runId: proposal.runId };
        answer =
          lang === 'hr'
            ? `Pripremam brief o "${subject}". Provjerio sam što već znaš i predložio ` +
              `${proposal.queryCount} ${proposal.queryCount === 1 ? 'pretragu' : 'pretrage'}: ` +
              `ništa još nije poslano. Otvori tijek na stranici Skills, odobri ili uredi ` +
              `plan pretraga, i prati svaki korak kako nastaje.`
            : `I'm preparing a brief on "${subject}". I've checked what you already know and ` +
              `proposed ${proposal.queryCount} ${proposal.queryCount === 1 ? 'search' : 'searches'}: ` +
              `nothing has been sent yet. Open the run on the Skills page to approve or edit ` +
              `the search plan, and watch each step as it happens.`;
      }
    } catch (error) {
      this.logger.warn(`skill_intent_failed: ${error instanceof Error ? error.message : 'error'}`);
      answer =
        lang === 'hr'
          ? `Trenutno ne mogu pripremiti brief. Pokušaj ponovno sa stranice Skills.`
          : `I couldn't start that brief just now. Try again from the Skills page.`;
    }
    yield { type: 'token', text: answer };
    const row = await this.storeAssistant(principal, conversationId, answer);
    yield {
      type: 'done',
      messageId: row.id,
      content: answer,
      citationViolations: 0,
      skillRun: runRef,
    };
  }

  private async *handleReplyIntent(
    principal: Principal,
    conversationId: string,
    target: string | null,
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    let answer: string;
    try {
      const candidates = await this.replyResolver!.findCandidates(principal, target);
      if (candidates.length === 0) {
        answer = target
          ? `I couldn't find a recent email from "${target}". Open the email in Cogeto and use "Draft reply" on it, and I'll write a suggested response.`
          : `I couldn't find a recent email to reply to. Open the email you mean and use "Draft reply" on it.`;
      } else if (target && candidates.length > 1) {
        const list = candidates
          .map(
            (c, i) =>
              `${i + 1}. ${c.from}, "${c.subject ?? '(no subject)'}" (${new Date(c.receivedAt).toLocaleDateString()})`,
          )
          .join('\n');
        answer = `I found more than one email that might match "${target}". Which one should I reply to?\n\n${list}\n\nTell me the sender or subject and I'll draft it.`;
      } else {
        const draft = await this.replyResolver!.createDraft(principal, candidates[0]!.emailId);
        answer = draft.recipientResolved
          ? `I've drafted a reply to ${draft.to}. Open the Approvals page to review it, then send it from your own mail client — Cogeto never sends mail for you.`
          : `I've drafted a reply, but this message looks forwarded and I couldn't work out the original recipient. Open the Approvals page, set the recipient, then send it yourself — Cogeto never sends mail.`;
      }
    } catch (error) {
      this.logger.warn(`reply_intent_failed: ${error instanceof Error ? error.message : 'error'}`);
      answer = `I couldn't draft that reply just now. You can open the email and use "Draft reply" on it.`;
    }

    yield { type: 'token', text: answer };
    const row = await this.storeAssistant(principal, conversationId, answer);
    yield { type: 'done', messageId: row.id, content: answer, citationViolations: 0 };
  }

  /** The last few turns of THIS conversation, oldest first — context for the
   * rewriter (F3). Scoped per conversation: a fact stated raw in one
   * thread never rides another thread's turn context. */
  private async recentTurns(conversationId: string): Promise<ConversationTurn[]> {
    const rows = await this.db
      .select({ role: chatMessage.role, content: chatMessage.content })
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, conversationId))
      .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
      .limit(REWRITE_HISTORY_TURNS);
    return rows.reverse();
  }

  /** Controller pre-stream check: 404 before SSE headers flush. */
  async assertConversation(principal: Principal, conversationId: string): Promise<void> {
    await this.requireConversation(principal, conversationId);
  }

  /** The owner's conversation or 404 — the gate every conversation-scoped
   * call goes through (existence must not leak, like the saga's NotFound). */
  private async requireConversation(
    principal: Principal,
    conversationId: string,
  ): Promise<ConversationRow> {
    const rows = await this.db
      .select()
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.ownerId, principal.userId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`conversation ${conversationId} not found`);
    return row;
  }

  /**
   * Every assistant reply lands through here: insert into the conversation it
   * was asked in, bump the sidebar's recency, and — once the first exchange
   * exists and the thread is still untitled — request the auto-title as a
   * worker job (§A.3: the model call never runs in the request path; the
   * enqueue is one transactional insert).
   */
  private async storeAssistant(
    principal: Principal,
    conversationId: string,
    content: string,
  ): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, conversationId, role: 'assistant', content })
      .returning();
    await this.touchConversation(conversationId, row!.createdAt);
    await this.maybeRequestTitle(principal, conversationId);
    return { id: row!.id };
  }

  /** updated_at IS the last-message time. */
  private async touchConversation(conversationId: string, at: Date): Promise<void> {
    await this.db
      .update(conversation)
      .set({ updatedAt: at })
      .where(eq(conversation.id, conversationId));
  }

  /**
   * The auto-title request: exactly ONCE per conversation — after its
   * FIRST exchange, while untitled and never manually named. One transactional
   * enqueue; the job retries with backoff on failure and, exhausted, parks in
   * dead_letter with the thread simply staying "New conversation". Every later
   * exchange costs one indexed count — no repeat enqueues, fast path intact.
   */
  private async maybeRequestTitle(principal: Principal, conversationId: string): Promise<void> {
    const rows = await this.db
      .select({ title: conversation.title, titleSetByUser: conversation.titleSetByUser })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    const row = rows[0];
    if (!row || row.title !== null || row.titleSetByUser) return;
    const replies = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatMessage)
      .where(
        and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.role, 'assistant')),
      );
    if ((replies[0]?.count ?? 0) !== 1) return;
    await this.db.transaction((tx) =>
      withTransactionalEnqueue(
        tx,
        {
          type: 'conversation.title_requested',
          payload: {
            source_type: 'chat_conversation',
            source_id: conversationId,
            owner_id: principal.userId,
          },
        },
        {
          type: CONVERSATION_TITLE_JOB_TYPE,
          payload: { source_type: 'chat_conversation', source_id: conversationId },
        },
      ),
    );
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(ANSWER_PROMPT.family, ANSWER_PROMPT.version);
    return this.prompt;
  }
}

/** The wire form of a conversation row. */
function toConversationDto(row: ConversationRow, lastMessage: string | null): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    titleSetByUser: row.titleSetByUser,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessagePreview: lastMessage === null ? null : lastMessage.slice(0, PREVIEW_CHARS),
  };
}

function toFactDto(hit: RetrievedMemory, index: number): ChatFactDto {
  return {
    marker: `F${index + 1}`,
    memoryId: hit.memory.id,
    claim: hit.memory.content,
    status: hit.memory.status,
    scope: hit.memory.scope,
    ownerId: hit.memory.ownerId,
    ownerName: null,
    sensitive: hit.memory.sensitive,
    subjectEntity: hit.memory.subjectEntity,
    sourceType: hit.memory.sourceType,
    sourceId: hit.memory.sourceId,
    validFrom: hit.memory.validFrom?.toISOString() ?? null,
    validUntil: hit.memory.validUntil?.toISOString() ?? null,
    signals: hit.signals,
    // The past-framing data contract: computed here,
    // consumed by the answer prompt AND the UI chip — testable without a model.
    pastBelief: isPastBelief(hit.memory),
    supersededBy: hit.memory.supersededBy,
  };
}
