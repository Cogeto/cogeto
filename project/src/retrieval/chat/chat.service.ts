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
  ChatMessageDto,
  ChatRememberedDto,
  ChatStreamEvent,
  NoteProcessingState,
  Principal,
} from '@cogeto/shared';
import {
  deadLetter,
  DRIZZLE,
  jobExecution,
  withTransactionalEnqueue,
} from '../../infrastructure/index';
import type { Db } from '../../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../../ingestion/index';
import { isPastBelief } from '../../memory/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { UserDirectory } from '../../identity/index';
import { RetrievalService } from '../retrieval.service';
import type { RetrievedMemory } from '../retrieval.service';
import type { ConversationTurn, CreateTaskIntent } from '../query-rewrite';
import {
  ANAPHORA_RE,
  detectCreateTaskIntent,
  detectEmailReplyIntent,
  rewriteQuery,
} from '../query-rewrite';
import { queryEntityCandidates } from '../query-entities';
import { CHAT_REPLY_RESOLVER } from './chat-reply-resolver.port';
import type { ChatReplyResolverPort } from './chat-reply-resolver.port';
import { chatMessage } from '../persistence/tables';
import {
  ANSWER_PROMPT,
  buildAnswerInput,
  NOTHING_ON_RECORD,
  NOTHING_OPEN,
  toStoredAnswer,
} from './answer-prompt';

/** How many facts the answer context receives (wider so aggregation fits, F5). */
const ANSWER_FACTS_TOP_K = 12;
/** How much history the chat page loads. */
const HISTORY_LIMIT = 200;
/** Turns of prior conversation the rewriter sees to resolve references (F3). */
const REWRITE_HISTORY_TURNS = 6;

/** Surrounding turns shown either side of a remembered message in its drawer. */
const CONTEXT_TURNS = 2;

/** Mirrors the task engine's condition heuristic (decision 0013 ruling 2) for
 * the create-task confirmation text ONLY — derivation re-detects downstream.
 * No leading \b: JS \b is ASCII-only and would never match before "čim". */
const CONDITION_HINT_RE =
  /(?:^|[^\p{L}])(?:after|once|when|as soon as|nakon što|kad(?:a)?|čim)\s+([^.;]{4,120})/iu;

/**
 * The chat area (S3-A). Asking a question is strictly fast path (§A.3): persist
 * → retrieve → generate — deliberately NO enqueue and no ingestion-stage work.
 *
 * Capture is separate and explicit (decision 0021): `rememberMessage` routes a
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
    /** The chat → email-reply seam (Session O4). Absent in the worker and bare
     * test harnesses — then the reply intent is simply inactive. */
    @Optional() @Inject(CHAT_REPLY_RESOLVER) private readonly replyResolver?: ChatReplyResolverPort,
  ) {}

  async listMessages(principal: Principal): Promise<ChatMessageDto[]> {
    const rows = await this.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.ownerId, principal.userId))
      .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id))
      .limit(HISTORY_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * "Remember this" (decision 0021): route a USER message through the normal
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
   * The chat context behind a remembered memory's source drawer (decision 0021):
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

    const before = await this.db
      .select()
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.ownerId, principal.userId),
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
          eq(chatMessage.ownerId, principal.userId),
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
    return { turns };
  }

  /**
   * One question → one SSE stream: sources first (the frontend builds its
   * citation map before tokens arrive), then token deltas, then done with the
   * stored form of the answer.
   */
  async *ask(principal: Principal, content: string): AsyncGenerator<ChatStreamEvent> {
    // Prior turns (before this one) feed the conversational rewriter (F3).
    const history = await this.recentTurns(principal);
    const [userRow] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, role: 'user', content })
      .returning();

    // Create-a-task intent (decision 0038): checked BEFORE the reply intent so
    // "remind me to reply to Ana" makes a task, not a draft. Deterministic
    // detection; a clear request routes this very message through the normal
    // chat capture → extraction → task derivation path (never a task row
    // directly); an ambiguous one asks; a bare trigger creates nothing.
    const createTask = detectCreateTaskIntent(content);
    if (createTask) {
      yield* this.handleCreateTaskIntent(principal, userRow!.id, createTask, history);
      return;
    }

    // Draft-a-reply intent (Session O4): deterministic detection; if it fires and
    // the resolver is wired, this turn creates an email reply draft (or asks /
    // declines) — fast path, no ingestion work, no sending. Then we return.
    if (this.replyResolver) {
      const replyIntent = detectEmailReplyIntent(content);
      if (replyIntent) {
        yield* this.handleReplyIntent(principal, replyIntent.target);
        return;
      }
    }

    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
      history,
    });
    const facts = retrieved.memories.map((hit, i) => toFactDto(hit, i));
    // Attribute cited shared facts to their owner (O2-B) — name-only; the gates
    // already decided these were visible to the caller.
    const names = await this.directory.displayNames(facts.map((f) => f.ownerId));
    for (const fact of facts) fact.ownerName = names.get(fact.ownerId) ?? null;
    yield { type: 'sources', facts };

    let answer: string;
    if (retrieved.mode === 'tasks' && (retrieved.tasks?.length ?? 0) === 0) {
      // Zero open loops is an ANSWER (all clear), not a data gap (F3-B).
      answer = NOTHING_OPEN;
      yield { type: 'token', text: answer };
    } else if (facts.length === 0) {
      // The zero-retrieval path: no model call, no generation from thin air.
      answer = NOTHING_ON_RECORD;
      yield { type: 'token', text: answer };
    } else {
      const prompt = await this.getPrompt();
      let buffer = '';
      const stream = this.gateway.completeStream({
        system: prompt.content,
        input: buildAnswerInput(facts, content, retrieved.mode, {
          temporal: retrieved.temporal,
          changes: retrieved.changes,
          tasks: retrieved.tasks,
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
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, role: 'assistant', content: stored })
      .returning();
    yield { type: 'done', messageId: row!.id, content: stored, citationViolations: violations };
  }

  /**
   * The draft-a-reply chat flow (Session O4). Resolve the target email against
   * the owner's recent emails, then act like a thoughtful assistant:
   *  - 0 matches      → say so, point to the drawer's "Draft reply".
   *  - >1 for a NAMED target → list the candidates and ask which (create nothing).
   *  - 1 (or "the last one") → create the draft via the approval path and confirm
   *    with a link. Cogeto never sends. No retrieval-answer, no ingestion work.
   */
  private async *handleReplyIntent(
    principal: Principal,
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
              `${i + 1}. ${c.from} — "${c.subject ?? '(no subject)'}" (${new Date(c.receivedAt).toLocaleDateString()})`,
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
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, role: 'assistant', content: answer })
      .returning();
    yield { type: 'done', messageId: row!.id, content: answer, citationViolations: 0 };
  }

  /**
   * The create-a-task chat flow (decision 0038). The user's own message is the
   * capture: a clear instruction stores its normalized commitment form on the
   * message and enqueues the NORMAL ingestion pipeline on it (source_type
   * 'chat'), so extraction, verification, admission and task derivation run
   * exactly as for a written note — this method never creates a task row and
   * never sends or mutates anything else. Ambiguity asks; a bare trigger
   * creates nothing. Fast path: the only model call is the (bounded, optional)
   * rewriter used to resolve references to earlier turns.
   */
  private async *handleCreateTaskIntent(
    principal: Principal,
    messageId: string,
    intent: CreateTaskIntent,
    history: ConversationTurn[],
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    const hr = intent.lang === 'hr';
    let answer: string;
    if (!intent.instruction) {
      answer = hr
        ? `Nema ničega što bi se moglo pretvoriti u zadatak. Recite mi što zadatak treba ` +
          `sadržavati — npr. "napravi zadatak da pošaljem Ani mapiranje čim potvrdi format".`
        : `I couldn't find anything actionable to turn into a task. Tell me what it should ` +
          `say — for example, "make a task to send Ana the revised mapping once she confirms the format".`;
    } else {
      let instruction = intent.instruction;
      // References to earlier turns resolve through the rewriter (it already
      // holds the recent history). Conservative: if no named person or thing
      // survives resolution, ask instead of guessing.
      if (ANAPHORA_RE.test(instruction) && queryEntityCandidates(instruction).length === 0) {
        const rewritten = await rewriteQuery(this.gateway, history, instruction);
        if (
          queryEntityCandidates(rewritten.query).length > 0 ||
          !ANAPHORA_RE.test(rewritten.query)
        ) {
          instruction = rewritten.query;
        }
      }
      if (ANAPHORA_RE.test(instruction) && queryEntityCandidates(instruction).length === 0) {
        answer = hr
          ? `Želim taj zadatak zabilježiti točno, ali ne mogu razaznati na koga ili što se ` +
            `"${intent.instruction}" odnosi. Recite mi osobu ili stavku (i eventualni uvjet), pa ću ga izraditi.`
          : `I want to get that task right, but I can't tell who or what "${intent.instruction}" ` +
            `refers to. Tell me the person or item (and any condition), and I'll create it.`;
      } else {
        // The capture (§A.3): normalized commitment text on the message + the
        // pipeline enqueue, one transaction — same contract as "remember this".
        const captureContent = `${intent.lang === 'hr' ? 'Zadatak' : 'Task'}: ${instruction}`;
        await this.db.transaction(async (tx) => {
          await tx.update(chatMessage).set({ captureContent }).where(eq(chatMessage.id, messageId));
          await withTransactionalEnqueue(
            tx,
            {
              type: 'chat.task_requested',
              payload: { source_type: 'chat', source_id: messageId, owner_id: principal.userId },
            },
            {
              type: INGESTION_PIPELINE_JOB_TYPE,
              payload: { source_type: 'chat', source_id: messageId },
            },
          );
        });
        const condition = CONDITION_HINT_RE.exec(instruction)?.[0]?.trim() ?? null;
        if (hr) {
          answer = condition
            ? `Zabilježeno kao zadatak: "${instruction}" — čekat će na "${condition}". ` +
              `Upravo se izrađuje i uskoro će se pojaviti na stranici Zadaci; izveden je iz ` +
              `ovog razgovora, pa izvor pokazuje ovamo.`
            : `Zabilježeno kao zadatak: "${instruction}". Upravo se izrađuje i uskoro će se ` +
              `pojaviti na stranici Zadaci; izveden je iz ovog razgovora, pa izvor pokazuje ovamo.`;
        } else {
          answer = condition
            ? `I've captured that as a task: "${instruction}" — it will wait on "${condition}". ` +
              `It's being created now and will show on your Tasks page in a moment, derived from ` +
              `this conversation so its provenance points here.`
            : `I've captured that as a task: "${instruction}". It's being created now and will ` +
              `show on your Tasks page in a moment, derived from this conversation so its ` +
              `provenance points here.`;
        }
      }
    }
    yield { type: 'token', text: answer };
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, role: 'assistant', content: answer })
      .returning();
    yield { type: 'done', messageId: row!.id, content: answer, citationViolations: 0 };
  }

  /** The last few turns, oldest first — context for the rewriter (F3). */
  private async recentTurns(principal: Principal): Promise<ConversationTurn[]> {
    const rows = await this.db
      .select({ role: chatMessage.role, content: chatMessage.content })
      .from(chatMessage)
      .where(eq(chatMessage.ownerId, principal.userId))
      .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
      .limit(REWRITE_HISTORY_TURNS);
    return rows.reverse();
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(ANSWER_PROMPT.family, ANSWER_PROMPT.version);
    return this.prompt;
  }
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
    // The past-framing data contract (decision 0012 ruling 6): computed here,
    // consumed by the answer prompt AND the UI chip — testable without a model.
    pastBelief: isPastBelief(hit.memory),
    supersededBy: hit.memory.supersededBy,
  };
}
