import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { ModelGateway } from '../model-gateway/index';
import type {
  CompletionRequest,
  CompletionResult,
  ResolvedModelProviders,
  StructuredExtractionRequest,
} from '../model-gateway/index';

/**
 * Cached model responses for the pull-request eval job (V2.0 item 3.4).
 *
 * Pull requests used to run the eval harness's BUILD only: a prompt change
 * that wrecked extraction merged green and was discovered post-merge by the
 * live gate. This decorator lets both suites run on every pull request,
 * including fork pull requests that hold no secret, against responses recorded
 * from a live run.
 *
 * ## What a cached run proves, and what it does not
 *
 * It CATCHES: prompt regressions, pipeline and routing regressions, scoring
 * and harness regressions, corpus mistakes. Anything where the same model
 * response should have produced a different score.
 *
 * It does NOT catch: model-side drift. `mistral-small-latest` is a moving
 * target and the cache freezes one day's behaviour. The live post-merge run
 * remains the authority for the published numbers, and only live runs feed the
 * trust artifacts: `--emit-json` refuses to run in replay mode.
 *
 * ## The key, and why a prompt change cannot hit it
 *
 * Every entry is keyed by a SHA-256 over, in order:
 *
 * 1. `EVAL_SCORING_VERSION` — the harness's own scoring version,
 * 2. the operation (`complete` / `structured` / `embed`),
 * 3. the requested tier and the model that tier RESOLVES to,
 * 4. the system prompt VERBATIM — which is the rendered prompt artifact, so a
 *    version bump and an uncommitted edit both miss by construction, not by
 *    anyone remembering to bump a number,
 * 5. the full rendered input verbatim, fences and all.
 *
 * Exactly three things are normalised before hashing, and each is AMBIENT: it
 * changes on every run whatever the code does, so leaving it in the key would
 * mean a cache that never hits, which is no gate at all.
 *
 * 1. **UUIDs** — a fresh Testcontainers database mints new ones every run.
 * 2. **The untrusted-data fence's boundary id** (audit 2.0 SEC-4 mints 18 hex
 *    characters per model call). Matched only inside its marker line, so the
 *    fence's presence and position still hash: removing a fence, or moving
 *    text out of one, still misses.
 * 3. **The now-block's wall clock** — stamped from `new Date()` on every chat
 *    turn. The instant is masked; the timezone and every other line of the
 *    block are not.
 *
 * Nothing else is normalised. Each carve-out is asserted in the unit suite,
 * beside the assertions that a prompt edit, a model change, a tier change and
 * a one-character input change each miss.
 *
 * A miss in replay mode FAILS the run naming the refresh command. It never
 * skips the case: a partial run reported as green is exactly the false green
 * this whole mechanism exists to prevent.
 */

/**
 * Bump when the harness's scoring changes in a way that makes recorded
 * responses no longer comparable. Bumping invalidates the whole cache.
 */
export const EVAL_SCORING_VERSION = 1;

export type EvalCacheMode = 'off' | 'record' | 'replay';

export const REFRESH_COMMAND = 'npm run eval:cache:refresh';

const entrySchema = z.object({
  /** Human-readable provenance for review; never part of the key. */
  op: z.string(),
  model: z.string(),
  tier: z.string().optional(),
  preview: z.string(),
  text: z.string(),
});
const cacheFileSchema = z.record(z.string(), entrySchema);

const manifestSchema = z.object({
  scoring_version: z.number(),
  configuration_id: z.string(),
  models: z.object({ pipeline: z.string(), answer: z.string(), embedding: z.string() }),
  recorded_at: z.string(),
  counts: z.object({ text: z.number(), embeddings: z.number() }),
});
export type EvalCacheManifest = z.infer<typeof manifestSchema>;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The untrusted-data fence carries a fresh random boundary id per model call
 * (audit 2.0 SEC-4). Matched only inside the marker line, never as a bare hex
 * run in content, so the fence's PRESENCE and POSITION still hash: removing a
 * fence, or moving text out of one, still misses the cache.
 */
const FENCE_RE = /(-----(?:BEGIN|END) UNTRUSTED DATA )[0-9a-f]{18}(-----)/g;

/**
 * The now-block's wall clock. `buildContextBlock` stamps
 * `NOW: <weekday>, <date>, <hh:mm> (<timezone>)` from `new Date()` on every
 * chat turn, so without this the chat suite misses the cache on the minute and
 * the fixtures would be worthless.
 *
 * The instant is masked; the TIMEZONE and every other line of the block are
 * not, so a change to the block's format, the language rule, or the user
 * context still misses. The residual limitation is stated in
 * docs/eval-golden-set.md: a cached run reproduces one wall-clock context, so
 * an assertion that depends on today's date relative to a case anchor is
 * covered by the live post-merge run, not by the cached one.
 */
const NOW_LINE_RE = /^(NOW: ).*?( \([^)\n]*\))$/gm;

/**
 * The only three normalisations, each of them ambient: they change on every
 * run whatever the code does, so leaving them in the key would mean a cache
 * that never hits, and no gate at all. Everything else, every character of the
 * prompt and of the fenced input, is hashed verbatim.
 */
export function normalizeForKey(value: string): string {
  return value
    .replace(UUID_RE, '<uuid>')
    .replace(FENCE_RE, '$1<boundary>$2')
    .replace(NOW_LINE_RE, '$1<now>$2');
}

export function evalCacheKey(parts: {
  op: 'complete' | 'structured' | 'embed';
  model: string;
  tier?: string;
  system?: string;
  input: string;
}): string {
  const canonical = JSON.stringify({
    v: EVAL_SCORING_VERSION,
    op: parts.op,
    tier: parts.tier ?? '',
    model: parts.model,
    system: normalizeForKey(parts.system ?? ''),
    input: normalizeForKey(parts.input),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function evalCacheModeFromEnv(env: NodeJS.ProcessEnv = process.env): EvalCacheMode {
  const raw = (env.COGETO_EVAL_CACHE ?? '').trim().toLowerCase();
  if (raw === 'record' || raw === 'replay') return raw;
  if (raw === '' || raw === 'off' || raw === '0') return 'off';
  throw new Error(`COGETO_EVAL_CACHE must be one of off | record | replay (got '${raw}')`);
}

export class EvalCacheMiss extends Error {
  constructor(op: string, preview: string) {
    super(
      `eval cache MISS (${op}): no recorded response for this input.\n` +
        `  input starts: ${preview}\n` +
        `  This is what a stale cache looks like. It is NOT skipped and NOT counted as a pass.\n` +
        `  Refresh the fixtures against the live models with: ${REFRESH_COMMAND}`,
    );
    this.name = 'EvalCacheMiss';
  }
}

/**
 * Two files, split by what a human can usefully review. Text responses are
 * pretty-printed JSON and are the reviewable half of a refresh diff; embedding
 * vectors are base64 float32 in a JSONL sidecar, exact rather than rounded,
 * because a rounded vector could flip a borderline similarity match and make
 * the cached run measure something the live run does not.
 */
export class EvalCacheStore {
  private readonly textFile: string;
  private readonly embeddingFile: string;
  private readonly manifestFile: string;
  private text = new Map<string, z.infer<typeof entrySchema>>();
  private embeddings = new Map<string, number[]>();
  private dirty = false;
  /**
   * Replay misses, counted and reported even when the caller swallows the
   * error. `rewriteQuery` catches everything and falls back to a safe default
   * by design, so a missed rewrite would otherwise degrade the run silently
   * and only surface as a strange failure three calls later. A run with any
   * miss FAILS, whoever caught the exception.
   */
  private missCount = 0;

  constructor(private readonly dir: string) {
    this.textFile = path.join(dir, 'responses.json');
    this.embeddingFile = path.join(dir, 'embeddings.jsonl');
    this.manifestFile = path.join(dir, 'manifest.json');
  }

  load(): void {
    if (existsSync(this.textFile)) {
      const parsed = cacheFileSchema.parse(JSON.parse(readFileSync(this.textFile, 'utf8')));
      this.text = new Map(Object.entries(parsed));
    }
    if (existsSync(this.embeddingFile)) {
      for (const line of readFileSync(this.embeddingFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { k: string; v: string };
        const buffer = Buffer.from(row.v, 'base64');
        const floats = new Float32Array(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        );
        this.embeddings.set(row.k, Array.from(floats));
      }
    }
  }

  readManifest(): EvalCacheManifest | null {
    if (!existsSync(this.manifestFile)) return null;
    return manifestSchema.parse(JSON.parse(readFileSync(this.manifestFile, 'utf8')));
  }

  getText(key: string): string | undefined {
    return this.text.get(key)?.text;
  }

  putText(key: string, entry: z.infer<typeof entrySchema>): void {
    this.text.set(key, entry);
    this.dirty = true;
  }

  getEmbedding(key: string): number[] | undefined {
    return this.embeddings.get(key);
  }

  putEmbedding(key: string, vector: number[]): void {
    this.embeddings.set(key, vector);
    this.dirty = true;
  }

  /** Deterministic on-disk order so a refresh diff shows only real changes. */
  flush(manifest: Omit<EvalCacheManifest, 'counts'>): void {
    if (!this.dirty) return;
    mkdirSync(this.dir, { recursive: true });
    const sortedText = Object.fromEntries(
      [...this.text.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    writeFileSync(this.textFile, `${JSON.stringify(sortedText, null, 2)}\n`, 'utf8');
    const lines = [...this.embeddings.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, vector]) => {
        const floats = Float32Array.from(vector);
        const base64 = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString(
          'base64',
        );
        return JSON.stringify({ k: key, v: base64 });
      });
    writeFileSync(this.embeddingFile, `${lines.join('\n')}\n`, 'utf8');
    writeFileSync(
      this.manifestFile,
      `${JSON.stringify(
        manifestSchema.parse({
          ...manifest,
          counts: { text: this.text.size, embeddings: this.embeddings.size },
        }),
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  get sizes(): { text: number; embeddings: number } {
    return { text: this.text.size, embeddings: this.embeddings.size };
  }

  get misses(): number {
    return this.missCount;
  }

  /** Log the miss the moment it happens, then let the caller throw. */
  noteMiss(op: string, preview: string): void {
    this.missCount += 1;
    console.error(`  CACHE MISS #${this.missCount} (${op}): ${preview}`);
  }
}

interface CachingOptions {
  mode: Exclude<EvalCacheMode, 'off'>;
  store: EvalCacheStore;
  /** The models each tier resolves to — part of every key. */
  models: { pipeline: string; answer: string; embedding: string };
}

export class CachingModelGateway extends ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly options: CachingOptions,
  ) {
    super();
  }

  private modelFor(
    tier: 'pipeline' | 'answer' | undefined,
    fallback: 'pipeline' | 'answer',
  ): string {
    return this.options.models[tier ?? fallback];
  }

  /** Count and log the miss, then hand back the error to throw. */
  private miss(op: string, input: string): EvalCacheMiss {
    this.options.store.noteMiss(op, preview(input));
    return new EvalCacheMiss(op, preview(input));
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.modelFor(request.tier, 'answer');
    const key = evalCacheKey({
      op: 'complete',
      model,
      tier: request.tier ?? 'answer',
      system: request.system,
      input: request.input,
    });
    const hit = this.options.store.getText(key);
    if (hit !== undefined) return { text: hit };
    if (this.options.mode === 'replay') throw this.miss('complete', request.input);
    const result = await this.inner.complete(request);
    this.options.store.putText(key, {
      op: 'complete',
      model,
      tier: request.tier ?? 'answer',
      preview: preview(request.input),
      text: result.text,
    });
    return result;
  }

  /**
   * Replay yields the recorded answer as ONE delta. The harnesses assemble the
   * full text and score that, so chunk boundaries are not observable; nothing
   * that is scored depends on them.
   */
  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const model = this.modelFor(request.tier, 'answer');
    const key = evalCacheKey({
      op: 'complete',
      model,
      tier: request.tier ?? 'answer',
      system: request.system,
      input: request.input,
    });
    const hit = this.options.store.getText(key);
    if (hit !== undefined) {
      yield hit;
      return;
    }
    if (this.options.mode === 'replay') throw this.miss('stream', request.input);
    let assembled = '';
    for await (const delta of this.inner.completeStream(request)) {
      assembled += delta;
      yield delta;
    }
    this.options.store.putText(key, {
      op: 'complete',
      model,
      tier: request.tier ?? 'answer',
      preview: preview(request.input),
      text: assembled,
    });
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const model = this.modelFor(request.tier, 'pipeline');
    const key = evalCacheKey({
      op: 'structured',
      model,
      tier: request.tier ?? 'pipeline',
      system: request.system,
      input: request.input,
    });
    const hit = this.options.store.getText(key);
    if (hit !== undefined) {
      // Validated on replay too: a schema change that the recorded response no
      // longer satisfies must fail loudly rather than resurrect stale shapes.
      return schema.parse(JSON.parse(hit));
    }
    if (this.options.mode === 'replay') throw this.miss('structured', request.input);
    const result = await this.inner.extractStructured(schema, request);
    this.options.store.putText(key, {
      op: 'structured',
      model,
      tier: request.tier ?? 'pipeline',
      preview: preview(request.input),
      text: JSON.stringify(result),
    });
    return result;
  }

  /**
   * Cached PER TEXT, not per batch, so a differently sized batch of the same
   * strings still hits. Batch composition is a caller detail and must not be
   * able to invalidate a cache.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const model = this.options.models.embedding;
    const keys = texts.map((text) => evalCacheKey({ op: 'embed', model, input: text }));
    const out = new Array<number[] | undefined>(texts.length);
    const missing: number[] = [];
    keys.forEach((key, index) => {
      const hit = this.options.store.getEmbedding(key);
      if (hit) out[index] = hit;
      else missing.push(index);
    });
    if (missing.length > 0) {
      if (this.options.mode === 'replay') throw this.miss('embed', texts[missing[0]!]!);
      const fresh = await this.inner.embed(missing.map((index) => texts[index]!));
      missing.forEach((index, position) => {
        const vector = fresh[position]!;
        out[index] = vector;
        this.options.store.putEmbedding(keys[index]!, vector);
      });
    }
    return out.map((vector) => vector!);
  }

  embeddingModelId(): string {
    return this.options.models.embedding;
  }
}

function preview(input: string): string {
  return input.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Wire the cache around a gateway. In `replay` the MANIFEST decides the models
 * that go into every key, not the environment: a fork pull request has no
 * provider configuration at all, and keys resolved from empty defaults would
 * miss everything for a reason that has nothing to do with quality.
 */
export function wrapWithEvalCache(
  inner: ModelGateway,
  options: {
    mode: EvalCacheMode;
    dir: string;
    providers: ResolvedModelProviders;
    /**
     * Reuse an already-loaded store. The chat harness wraps a second gateway
     * for the coverage grader; two stores over one directory would each hold
     * half the recording and the second flush would drop the other half.
     */
    store?: EvalCacheStore | null;
  },
): { gateway: ModelGateway; store: EvalCacheStore | null; manifest: EvalCacheManifest | null } {
  if (options.mode === 'off') return { gateway: inner, store: null, manifest: null };
  let store = options.store ?? null;
  if (!store) {
    store = new EvalCacheStore(options.dir);
    store.load();
  }
  const manifest = store.readManifest();
  if (options.mode === 'replay') {
    if (!manifest) {
      throw new Error(
        `eval cache is empty (no ${path.join(options.dir, 'manifest.json')}). Record it with: ${REFRESH_COMMAND}`,
      );
    }
    if (manifest.scoring_version !== EVAL_SCORING_VERSION) {
      throw new Error(
        `eval cache was recorded at scoring version ${manifest.scoring_version}, harness is at ` +
          `${EVAL_SCORING_VERSION}. Every key changed. Refresh with: ${REFRESH_COMMAND}`,
      );
    }
  }
  const models =
    options.mode === 'replay' && manifest
      ? manifest.models
      : {
          pipeline: options.providers.tiers.pipeline.model,
          answer: options.providers.tiers.answer.model,
          embedding: options.providers.tiers.embedding.model,
        };
  return {
    gateway: new CachingModelGateway(inner, { mode: options.mode, store, models }),
    store,
    manifest,
  };
}
