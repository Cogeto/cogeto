import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The locale guard, proved by breaking it (F13, F14, issue "Close the gap in
 * the guard").
 *
 * `npm run i18n:check` runs inside `lint`, which is a required check, so what
 * it catches is what cannot regress. Asserting that it PASSES on a clean tree
 * says nothing: a check that always passes also always passes. Each case here
 * introduces one deliberate regression into a COPY of the repository, runs the
 * real script against that copy, and asserts it fails naming the offence.
 *
 *   clean_tree_passes            — the baseline, so a failure below means the
 *     regression was caught and not that the tree was already broken.
 *   missing_key                  — a key `en` has and another locale does not.
 *   dropped_placeholder          — a translation that lost its {{variable}}.
 *   missing_plural_category      — Croatian without its `_few` form.
 *   untranslated_value           — a value reverted to its English source,
 *     which is how a locale silently slides back to scaffold state.
 *   dead_identical_entry         — an allowlist entry that excuses nothing,
 *     which is how the allowlist would grow into a rubber stamp.
 *   server_error_without_a_code  — an HTTP failure raised directly instead of
 *     through `userError`/`untranslatedError`, which is exactly the shape that
 *     kept 197 English sentences invisible to this check.
 *   server_error_english_drift   — a throw-site sentence that no longer matches
 *     the `serverErrors` key translators worked from.
 *   orphaned_server_error_key    — a `serverErrors` key no throw site raises.
 *   hardcoded_jsx_literal        — user-visible text that never went through
 *     `t()`, in the two-word shape the detector was widened to catch.
 */
const REPO = path.resolve(process.cwd(), '../..');

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

/** A copy of everything the check reads, and nothing else: it is a big tree. */
function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cogeto-i18n-guard-'));
  for (const rel of [
    'scripts/ci/check-i18n.mjs',
    'scripts/ci/i18n-keys.mjs',
    'scripts/ci/i18n-identical.json',
    'scripts/ci/server-error-codes.mjs',
  ]) {
    cpSync(path.join(REPO, rel), path.join(root, rel), { recursive: true });
  }
  for (const rel of ['project/web/src', 'project/src']) {
    cpSync(path.join(REPO, rel), path.join(root, rel), {
      recursive: true,
      filter: (source) => !source.includes('node_modules') && !source.endsWith('/dist'),
    });
  }
  workspace = root;
  return root;
}

function check(root: string): { ok: boolean; out: string } {
  const result = spawnSync('node', ['scripts/ci/check-i18n.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

const edit = (root: string, rel: string, change: (text: string) => string): void => {
  const file = path.join(root, rel);
  writeFileSync(file, change(readFileSync(file, 'utf8')));
};

const editJson = (root: string, rel: string, change: (value: never) => void): void => {
  const file = path.join(root, rel);
  const value = JSON.parse(readFileSync(file, 'utf8')) as never;
  change(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

describe('the locale guard fails on a deliberate regression', () => {
  it('clean_tree_passes', () => {
    const result = check(sandbox());
    expect(result.out).toContain('fully translated');
    expect(result.ok).toBe(true);
  });

  it('missing_key', () => {
    const root = sandbox();
    editJson(root, 'project/web/src/locales/hr/review.json', (value) => {
      delete (value as Record<string, unknown>).loading;
    });
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('MISSING key "loading"');
  });

  it('dropped_placeholder', () => {
    const root = sandbox();
    editJson(root, 'project/web/src/locales/de/sources.json', (value) => {
      (value as { locator: { page: string } }).locator.page = 'Seite';
    });
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('dropped the placeholder {{page}}');
  });

  it('missing_plural_category', () => {
    const root = sandbox();
    editJson(root, 'project/web/src/locales/hr/sources.json', (value) => {
      delete (value as { list: { factCount_few?: string } }).list.factCount_few;
    });
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('MISSING plural form "list.factCount_few"');
  });

  it('untranslated_value', () => {
    const root = sandbox();
    const english = JSON.parse(
      readFileSync(path.join(root, 'project/web/src/locales/en/review.json'), 'utf8'),
    ) as { loading: string };
    editJson(root, 'project/web/src/locales/hr/review.json', (value) => {
      (value as { loading: string }).loading = english.loading;
    });
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('still their English source');
    expect(result.out).toContain('hr/review.json: "loading"');
  });

  it('dead_identical_entry', () => {
    const root = sandbox();
    editJson(root, 'scripts/ci/i18n-identical.json', (value) => {
      (value as { web: { review?: string[] } }).web.review = ['loading'];
    });
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('excuses nothing');
  });

  it('server_error_without_a_code', () => {
    const root = sandbox();
    edit(root, 'project/src/notes/notes.controller.ts', (text) =>
      text.replace(
        "userError.notFound('note.notFound', 'note {{id}} not found', { id })",
        'new NotFoundException(`note ${id} not found`)',
      ),
    );
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('raises an HTTP failure directly');
  });

  it('server_error_english_drift', () => {
    const root = sandbox();
    edit(root, 'project/src/projects/project.service.ts', (text) =>
      text.replace(
        "userError.badRequest('project.nameRequired', 'a project needs a name')",
        "userError.badRequest('project.nameRequired', 'a project must have a name')",
      ),
    );
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('has drifted from the sentence at the throw site');
  });

  it('orphaned_server_error_key', () => {
    const root = sandbox();
    editJson(root, 'project/web/src/locales/en/serverErrors.json', (value) => {
      (value as { invented?: Record<string, string> }).invented = { code: 'nobody raises this' };
    });
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('ORPHANED key "invented.code"');
  });

  it('hardcoded_jsx_literal', () => {
    const root = sandbox();
    edit(root, 'project/web/src/pages/Review.tsx', (text) =>
      text.replace('<p className="whitespace-pre-wrap">', '<p><span>Save changes</span>'),
    );
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('hardcoded JSX text "Save changes"');
  });
});
