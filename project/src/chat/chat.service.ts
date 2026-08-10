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
  AmbiguityDecisionDto,
  ChatContextDto,
  ChatMessagePage,
  ChatRememberedDto,
  ChatStreamEvent,
  ConversationDto,
  NoteProcessingState,
  Principal,
} from '@cogeto/shared';
import {
  buildContextBlock,
  DEFAULT_INSTANCE_TIMEZONE,
  DRIZZLE,
  EMPTY_USER_CONTEXT,
  jobRunState,
  UserContextService,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db, UserContextRecord } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { UserDirectory } from '../identity/index';
import { RetrievalService } from '../retrieval/index';
import type { ConversationTurn } from '../retrieval/index';
import {
  ANAPHORA_RE,
  detectResearchIntent,
  detectSkillBriefIntent,
  detectSmallTalk,
  rewriteQuery,
} from '../retrieval/index';
import { queryEntityCandidates } from '../retrieval/index';
import type { ChatReplyResolverPort } from './chat-reply-resolver.port';
import type { ChatResearchResolverPort } from './chat-research-resolver.port';
import type { ChatSkillResolverPort } from './chat-skill-resolver.port';
import type { ChatAttachmentsService } from './chat-attachments.service';
import { chatMessage, conversation } from './persistence/tables';
import type { ConversationRow } from './persistence/tables';
import { CONVERSATION_TITLE_JOB_TYPE } from './conversation-titler';
import { MemoryAnswerHandler } from './intents/answer.handler';
import { ReplyIntentHandler } from './intents/reply.handler';
import { ResearchIntentHandler } from './intents/research.handler';
import { SkillBriefHandler } from './intents/skill-brief.handler';
import { SmallTalkHandler } from './intents/small-talk.handler';
import type { ChatTurnSink } from './intents/intent-plumbing';
import { ANSWER_PROMPT } from './answer-prompt';
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

/**
 * Caps on transient-attachment text entering the answer input (V2.2 item
 * 5.1): per file and across the conversation's files, oldest first. The read
 * itself is already bounded by the parse caps; these bound the PROMPT, so a
 * long document contributes its opening rather than crowding out the facts.
 */
const ATTACHMENT_ANSWER_CHARS = 16_000;
const ATTACHMENT_ANSWER_TOTAL_CHARS = 32_000;

/** The per-turn user context: record + effective tz + rendered blocks. */
interface AskContext {
  record: UserContextRecord;
  timeZone: string;
  rewriteBlock: string;
  answerBlock: string;
}

/**
 * ChatService's optional collaborators, resolved BY NAME (V2.0 item 3.6
 * part 4, issue 1). These used to be five trailing `@Optional()` constructor
 * parameters whose order was load-bearing in nine manual construction sites:
 * inserting or reordering one silently injected the wrong service or
 * `undefined`, with no crash and no failing test. A named field cannot shift.
 *
 * The Nest side is a factory provider (`CHAT_SERVICE_OPTIONS`) that resolves
 * each field by its injection token; manual callers (eval, integration
 * harnesses) name exactly the fields they wire. Absent fields keep their
 * documented degraded behaviour: the matching intent is simply inactive, and
 * context falls back to the instance defaults.
 */
export interface ChatServiceOptions {
  /** The chat → email-reply seam; absent → the reply intent is inactive. */
  replyResolver?: ChatReplyResolverPort;
  /** The chat → research seam; absent → the research intent is inactive. */
  researchResolver?: ChatResearchResolverPort;
  /** The chat → skill seam; absent → the brief intent is inactive. */
  skillResolver?: ChatSkillResolverPort;
  /** Instance timezone for the router's precomputed rewrite. */
  timeZone?: string;
  /** Per-user context + language; absent → instance defaults, English. */
  userContext?: UserContextService;
  /** Conversation attachments (V2.2 item 5.1); absent → the ask path neither
   * links attachments nor injects transient texts, and attaching is a
   * controller capability this service does not reach. */
  attachments?: ChatAttachmentsService;
  /**
   * The user's own answer-model choice (V2.4 item 7.1). Absent → nobody has a
   * choice and every answer routes to the assigned answer tier, which is the
   * behaviour of every instance before this existed.
   */
  answerModelChoice?: { optionIdFor(userId: string): Promise<string | null> };
}

export const CHAT_SERVICE_OPTIONS = Symbol('CHAT_SERVICE_OPTIONS');

/**
 * The chat area. Asking a question is strictly fast path (spec §15.4): persist
 * → retrieve → generate — deliberately NO enqueue and no ingestion-stage work.
 *
 * Capture is separate and explicit: `rememberMessage` routes a
 * USER message through the normal pipeline (source_type 'chat'). The persisted
 * chat_message rows are those memories' provenance targets. The assistant's
 * own replies are never captured.
 */
@Injectable()
export class ChatService {
  private prompt?: PromptArtifact;
  private readonly logger = new Logger(ChatService.name);

  private readonly replyResolver?: ChatReplyResolverPort;
  private readonly researchResolver?: ChatResearchResolverPort;
  private readonly skillResolver?: ChatSkillResolverPort;
  private readonly timeZone: string;
  private readonly userContext?: UserContextService;
  private readonly attachments?: ChatAttachmentsService;
  private readonly answerModelChoice?: { optionIdFor(userId: string): Promise<string | null> };

  private readonly smallTalkHandler: SmallTalkHandler;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly retrieval: RetrievalService,
    private readonly gateway: ModelGateway,
    private readonly directory: UserDirectory,
    /** Every optional collaborator, by NAME — see ChatServiceOptions. */
    @Optional() @Inject(CHAT_SERVICE_OPTIONS) options?: ChatServiceOptions,
  ) {
    this.replyResolver = options?.replyResolver;
    this.researchResolver = options?.researchResolver;
    this.skillResolver = options?.skillResolver;
    this.timeZone = options?.timeZone ?? DEFAULT_INSTANCE_TIMEZONE;
    this.userContext = options?.userContext;
    this.attachments = options?.attachments;
    this.answerModelChoice = options?.answerModelChoice;
    this.smallTalkHandler = new SmallTalkHandler(this.gateway, this.sink());
  }

  /** The handlers' narrow view of this service (see intent-plumbing). */
  private sink(): ChatTurnSink {
    return {
      storeAssistant: (
        principal: Principal,
        conversationId: string,
        content: string,
        thinking?: string | null,
        ambiguity?: AmbiguityDecisionDto | null,
      ) =>
        this.storeAssistant(
          principal,
          conversationId,
          content,
          thinking ?? null,
          ambiguity ?? null,
        ),
      getPrompt: () => this.getPrompt(),
      readFocus: (conversationId: string) => this.readFocus(conversationId),
      writeFocus: (conversationId: string, subject: string) =>
        this.writeFocus(conversationId, subject),
      // Never fails a turn: an unreachable choice means the assigned answer
      // tier, which is a working answer rather than a failed one.
      answerOptionFor: (userId: string) =>
        this.answerModelChoice?.optionIdFor(userId).catch(() => null) ?? Promise.resolve(null),
      logWarn: (message: string) => this.logger.warn(message),
    };
  }

  /**
   * The app composition root's boot assertion (V2.0 item 3.6 part 4): the
   * served chat surface must have EVERY seam wired. An absent resolver
   * degrades silently by design in bare harnesses, which is exactly why the
   * root that serves real traffic verifies presence at boot instead of
   * trusting composition by inspection.
   */
  assertFullyWired(): void {
    const missing = [
      this.replyResolver ? null : 'replyResolver',
      this.researchResolver ? null : 'researchResolver',
      this.skillResolver ? null : 'skillResolver',
      this.userContext ? null : 'userContext',
      this.attachments ? null : 'attachments',
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      throw new Error(
        `ChatService is not fully wired: missing ${missing.join(', ')}. The app root serves ` +
          'chat with every intent active; a missing seam here means a composition regression ' +
          'that would otherwise disable the intent silently.',
      );
    }
  }

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
        `you have ${MAX_ACTIVE_CONVERSATIONS} active conversations, archive or delete some first`,
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
        thinking: row.thinking,
        ambiguity: row.ambiguity ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total: totalRows[0]?.count ?? 0,
    };
  }

  /**
   * "Remember this": route a USER message through the normal
   * pipeline (source_type 'chat', source_id = message id). Transactional via the
   * outbox (spec §15.4), idempotency-keyed so a double-click captures at most once. The
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
        'only your own messages can be remembered: the assistant’s replies are never captured',
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

    return jobRunState(this.db, {
      sourceType: 'chat',
      sourceId: messageId,
      jobType: INGESTION_PIPELINE_JOB_TYPE,
    });
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
  /**
   * One question → one SSE stream: sources first (the frontend builds its
   * citation map before tokens arrive), then token deltas, then done with the
   * stored form of the answer.
   *
   * THE ORCHESTRATOR (V2.0 item 3.6 part 4). Routing order is
   * CHAT_ROUTING_ORDER, asserted by chat-routing.spec.ts — one router, all
   * capabilities: deterministic guards first (small-talk lexicon, skill
   * brief, research), then ONE bounded pipeline-tier call (the rewriter, now
   * also the classifier) whose result routes model-classified small talk, the
   * reply intent (with resolved anaphora), and the memory/knowledge answer
   * paths. Classification failure falls back to the memory-question path.
   * Each intent's body lives in its handler under ./intents; this method owns
   * only the sequence.
   */
  async *ask(
    principal: Principal,
    content: string,
    conversationId: string,
    options: {
      /** issue #424: false answers directly; absent or true deliberates. */
      thinking?: boolean;
      /** Attachments sent with this message (V2.2 item 5.1) — linked to the
       * user row so the conversation renders them under it. */
      attachmentIds?: string[];
    } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    // The chat path is always EXPLICIT about the mode (the paired sampler
    // profiles belong to it); background callers stay unset and unchanged.
    const thinkingMode: 'on' | 'off' = options.thinking === false ? 'off' : 'on';
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
    if (this.attachments && (options.attachmentIds?.length ?? 0) > 0) {
      await this.attachments.linkToMessage(
        principal,
        conversationId,
        userRow!.id,
        options.attachmentIds!,
      );
    }

    // 1. small_talk_lexicon — deterministic: a pure pleasantry gets a
    // natural reply; no retrieval, no model call, no citation theatre.
    const smallTalk = detectSmallTalk(content);
    if (smallTalk) {
      yield* this.smallTalkHandler.handleLexicon(principal, conversationId, smallTalk);
      return;
    }

    // 2. skill_brief — checked BEFORE the research patterns so
    // "research X before Thursday" becomes a brief, not a plain search. This
    // turn only starts PLANNING; nothing leaves until the plan is approved.
    if (this.skillResolver) {
      const brief = detectSkillBriefIntent(content);
      if (brief) {
        yield* new SkillBriefHandler(this.skillResolver, this.sink()).handle(
          principal,
          conversationId,
          brief.subject,
          brief.lang,
        );
        return;
      }
    }

    // 3. research — deterministic, explicitly invoked: an imperative research
    // verb, never an ordinary question. This turn only OPENS the gate;
    // NOTHING is sent until the user approves on the Research page. A topic
    // leaning on earlier turns ("research her company") resolves through the
    // rewriter first.
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
        yield* new ResearchIntentHandler(this.researchResolver, this.sink()).handle(
          principal,
          conversationId,
          topic,
          research.lang,
        );
        return;
      }
    }

    // 4. router_rewrite — ONE bounded pipeline-tier call rewrites the turn
    // AND classifies it. Failure/timeout falls back to the raw query with
    // class 'personal' — the memory-question path.
    const rewrite = await this.routerRewrite(history, content, { alwaysClassify: true }, ctx);

    // 5. model_small_talk — pleasantries and meta beyond the lexicon: a
    // natural, brief answer-tier reply; still no retrieval.
    if (rewrite.questionClass === 'smalltalk') {
      yield* this.smallTalkHandler.handleModel(
        principal,
        conversationId,
        content,
        history,
        ctx.answerBlock,
        thinkingMode,
      );
      return;
    }

    // 6. reply_draft — deterministic detection on the raw turn; the router's
    // resolved entities let "draft a reply to her last email" reach the right
    // sender. Fast path, no ingestion work, no sending.
    if (this.replyResolver && rewrite.emailReply) {
      yield* new ReplyIntentHandler(this.replyResolver, this.sink()).handle(
        principal,
        conversationId,
        rewrite.emailReply.target,
        ctx.record.preferredLanguage,
      );
      return;
    }

    // 7. memory_answer — memory-first retrieval for BOTH personal and
    // knowledge questions; grounded facts always come first. Transient
    // conversation attachments (V2.2 item 5.1) join as fenced provided
    // ground — this conversation's only, capped so a long file contributes
    // its opening rather than crowding out the facts.
    yield* new MemoryAnswerHandler(this.retrieval, this.gateway, this.directory, this.sink(), () =>
      Boolean(this.researchResolver),
    ).handle(
      principal,
      conversationId,
      content,
      history,
      rewrite,
      {
        record: ctx.record,
        answerBlock: ctx.answerBlock,
        attachments: await this.transientAttachments(principal, conversationId),
        // The previous assistant turn's stored decision (V2.3 item 6.3): how
        // a fan-out's "which did you mean?" reply resolves deterministically.
        priorAmbiguity: await this.lastAssistantAmbiguity(conversationId),
      },
      thinkingMode,
    );
  }

  /** The latest assistant message's recorded ambiguity decision, if any. */
  private async lastAssistantAmbiguity(
    conversationId: string,
  ): Promise<AmbiguityDecisionDto | null> {
    const rows = await this.db
      .select({ ambiguity: chatMessage.ambiguity })
      .from(chatMessage)
      .where(and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.role, 'assistant')))
      .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
      .limit(1);
    return rows[0]?.ambiguity ?? null;
  }

  /** The conversation's ready transient texts, capped for the answer input. */
  private async transientAttachments(
    principal: Principal,
    conversationId: string,
  ): Promise<{ name: string; text: string }[]> {
    if (!this.attachments) return [];
    const texts = await this.attachments.transientTextsFor(principal.userId, conversationId);
    const capped: { name: string; text: string }[] = [];
    let budget = ATTACHMENT_ANSWER_TOTAL_CHARS;
    for (const item of texts) {
      if (budget <= 0) break;
      const slice = item.text.slice(0, Math.min(ATTACHMENT_ANSWER_CHARS, budget));
      budget -= slice.length;
      capped.push({ name: item.name, text: slice });
    }
    return capped;
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
   * worker job (spec §15.4: the model call never runs in the request path; the
   * enqueue is one transactional insert).
   */
  private async storeAssistant(
    principal: Principal,
    conversationId: string,
    content: string,
    thinking: string | null = null,
    ambiguity: AmbiguityDecisionDto | null = null,
  ): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(chatMessage)
      .values({
        ownerId: principal.userId,
        conversationId,
        role: 'assistant',
        content,
        thinking,
        ambiguity,
      })
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

  /**
   * The conversation focus (issue #479, layer 3): what this conversation is
   * currently about. Owner scoping comes from the conversation row itself,
   * which every read in this service already gates.
   */
  private async readFocus(
    conversationId: string,
  ): Promise<{ subject: string; setAt: Date } | null> {
    const rows = await this.db
      .select({ subject: conversation.focusSubject, setAt: conversation.focusSetAt })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    const row = rows[0];
    return row?.subject && row.setAt ? { subject: row.subject, setAt: row.setAt } : null;
  }

  private async writeFocus(conversationId: string, subject: string): Promise<void> {
    await this.db
      .update(conversation)
      .set({ focusSubject: subject, focusSetAt: new Date() })
      .where(eq(conversation.id, conversationId));
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
