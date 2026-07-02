import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { eq, and } from 'drizzle-orm';
import type { DbOrTx } from '../infrastructure/index';
import { promptRegistry } from './persistence/tables';

/**
 * Loads versioned prompt artifacts from project/prompts/ (§B.7):
 * one directory per family, numbered immutable files (v0001.md, v0002.md, …).
 */
const DEFAULT_PROMPTS_DIR = path.resolve(__dirname, '..', '..', '..', 'prompts');

export interface PromptArtifact {
  family: string;
  version: string;
  content: string;
  contentHash: string;
}

export async function loadPrompt(
  family: string,
  version: string,
  promptsDir: string = process.env.COGETO_PROMPTS_DIR ?? DEFAULT_PROMPTS_DIR,
): Promise<PromptArtifact> {
  if (!/^v\d{4}$/.test(version)) {
    throw new Error(`prompt version must look like v0001, got: ${version}`);
  }
  const file = path.join(promptsDir, family, `${version}.md`);
  const content = await readFile(file, 'utf8');
  return {
    family,
    version,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

/**
 * Records a prompt version in the registry (id, family, version, content_hash).
 * Immutability check: re-recording an existing version with a different hash fails.
 */
export async function recordPromptVersion(db: DbOrTx, prompt: PromptArtifact): Promise<void> {
  const existing = await db
    .select()
    .from(promptRegistry)
    .where(
      and(eq(promptRegistry.family, prompt.family), eq(promptRegistry.version, prompt.version)),
    )
    .limit(1);
  const row = existing[0];
  if (row) {
    if (row.contentHash !== prompt.contentHash) {
      throw new Error(
        `prompt ${prompt.family}/${prompt.version} is immutable but its content changed ` +
          `(registry ${row.contentHash.slice(0, 12)}…, file ${prompt.contentHash.slice(0, 12)}…)`,
      );
    }
    return;
  }
  await db.insert(promptRegistry).values({
    family: prompt.family,
    version: prompt.version,
    contentHash: prompt.contentHash,
  });
}
