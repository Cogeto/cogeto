import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertDemoAllowed } from '../config';
import { loadCorpus } from './corpus';

/**
 * Fast, container-free demo guards (decision 0022):
 *  - demo_disabled_in_production: the production flag refuses the demo seed/reset.
 *  - demo_pipeline_real: the seed path writes ONLY through the public HTTP API —
 *    no direct memory-table inserts anywhere in the seed/capture code.
 */

describe('demo_disabled_in_production', () => {
  it('refuses when the production flag is set, even with demo mode on', () => {
    expect(() => assertDemoAllowed({ demoMode: true, production: true })).toThrow(/production/i);
  });

  it('refuses when demo mode is off', () => {
    expect(() => assertDemoAllowed({ demoMode: false, production: false })).toThrow(
      /COGETO_DEMO_MODE/,
    );
  });

  it('allows only a non-production instance with demo mode on', () => {
    expect(() => assertDemoAllowed({ demoMode: true, production: false })).not.toThrow();
  });
});

describe('demo_pipeline_real', () => {
  const demoDir = path.resolve(__dirname);
  const read = (file: string): string => readFileSync(path.join(demoDir, file), 'utf8');

  // The files that make up the seed's data-writing path.
  const seedPath = ['http-client.ts', 'seed.ts', 'corpus.ts'];

  it('creates content ONLY through the public HTTP endpoints', () => {
    const client = read('http-client.ts');
    expect(client).toContain('/api/notes');
    expect(client).toContain('/api/chat');
    expect(client).toContain('/api/files');
    // The client's only outbound mechanism is fetch — no DB handle in sight.
    expect(client).toContain('fetch(');
    expect(client).not.toMatch(/\bpg\b|drizzle|\.query\(|new Pool/);
  });

  it('never inserts a memory (or any pipeline row) directly in the seed path', () => {
    for (const file of seedPath) {
      const src = read(file);
      expect(src, `${file} must not INSERT into memory`).not.toMatch(/insert\s+into\s+memory/i);
      expect(src, `${file} must not call .insert(memory`).not.toMatch(/\.insert\(\s*memory/);
      expect(src, `${file} must not use createFromFact`).not.toContain('createFromFact');
      expect(src, `${file} must not use admitExtractedFact`).not.toContain('admitExtractedFact');
      expect(src, `${file} must not use the seed fixtures`).not.toContain('seedObjectFixture');
    }
  });

  it('the corpus is authored data, feedable through the API (≥25 notes, en + hr, one document)', async () => {
    const corpus = await loadCorpus();
    expect(corpus.notes.length).toBeGreaterThanOrEqual(25);
    expect(corpus.notes.some((n) => n.lang === 'hr')).toBe(true);
    expect(corpus.notes.filter((n) => n.lang === 'hr').length).toBeGreaterThanOrEqual(2);
    expect(corpus.notes.some((n) => n.channel === 'chat')).toBe(true);
    expect(corpus.document.file).toMatch(/\.pdf$/);
  });
});
