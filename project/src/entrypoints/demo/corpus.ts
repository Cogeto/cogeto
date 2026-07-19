import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Loads and validates the Ana sandbox corpus (decision 0022). The authored world
 * lives in `project/demo/`; this reads it, never fabricates it. The seed feeds
 * every item through the real public HTTP API — see `./seed.ts`.
 */

const noteSchema = z.object({
  id: z.string().min(1),
  lang: z.enum(['en', 'hr']),
  channel: z.enum(['note', 'chat']),
  daysAgo: z.int().min(0).max(400),
  role: z.string().min(1),
  text: z.string().min(1).max(20_000),
});

const documentSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  title: z.string().min(1),
  scope: z.enum(['private', 'shared']),
  daysAgo: z.int().min(0).max(400),
  role: z.string().min(1),
  expectContains: z.array(z.string().min(1)).min(1),
});

const corpusSchema = z.object({
  persona: z.record(z.string(), z.unknown()),
  notes: z.array(noteSchema).min(20),
  document: documentSchema,
});

export type CorpusNote = z.infer<typeof noteSchema>;
export type CorpusDocument = z.infer<typeof documentSchema>;
export type Corpus = z.infer<typeof corpusSchema>;

/**
 * The `project/demo/` root. Default resolves from the compiled location
 * (`project/src/dist/entrypoints/demo/corpus.js` → `project/demo`); tests and
 * vitest set `COGETO_DEMO_DIR` explicitly, mirroring `COGETO_PROMPTS_DIR`.
 */
const DEFAULT_DEMO_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'demo');
export function demoRoot(): string {
  return process.env.COGETO_DEMO_DIR ? path.resolve(process.env.COGETO_DEMO_DIR) : DEFAULT_DEMO_DIR;
}

export async function loadCorpus(): Promise<Corpus> {
  const file = path.join(demoRoot(), 'seed', 'corpus.json');
  const raw = await readFile(file, 'utf8');
  const parsed = corpusSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid demo corpus at ${file}:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  // Ids must be unique — they key aging and assertions.
  const ids = new Set<string>();
  for (const note of parsed.data.notes) {
    if (ids.has(note.id)) throw new Error(`duplicate corpus note id: ${note.id}`);
    ids.add(note.id);
  }
  return parsed.data;
}

export async function loadDocumentBytes(doc: CorpusDocument): Promise<Buffer> {
  return readFile(path.join(demoRoot(), 'assets', doc.file));
}
