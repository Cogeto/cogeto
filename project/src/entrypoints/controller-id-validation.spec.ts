import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * controller_id_validation (issue #636).
 *
 * Most routes that take an identifier declare `@Param('id', ParseUUIDPipe)`,
 * so a malformed value is refused at the boundary with a 400 saying what was
 * wrong. Five sites across four modules did not, and the value travelled all
 * the way to a `WHERE id = $1` against a `uuid` column, where Postgres raised
 * `invalid input syntax for type uuid` and the caller got a 500. Nothing leaks
 * — the message never reaches the client — but a client error reported as a
 * server error is a lie about whose fault it is, it puts noise in the logs and
 * the dead-letter view, and it is the one shape of request every scanner
 * sends.
 *
 * A scan rather than five route tests, because the defect was uniformity: the
 * routes that had the pipe were fine and nobody noticed the ones that did not.
 * A new controller now fails the build instead.
 *
 * The exemptions below are identifiers that are genuinely NOT uuids. Each is
 * named with its reason; the list is the assertion, so adding to it is a
 * deliberate act in a diff rather than a silent omission.
 */

const SRC = path.resolve(__dirname, '..');

/**
 * Params that look like identifiers but are not uuids, by file. A source id is
 * a uuid for some source types and an object key (`org/user/scope/file-…`) for
 * others, so the registry validates the TYPE and the id stays free text.
 */
const NOT_A_UUID: Record<string, string[]> = {
  // The source registry's `(type, id)` pair: `id` is an object key for
  // object-backed types. `assertSourceType` validates the half that can be.
  'memory/sources.controller.ts': ['id'],
  'ingestion/source-context.controller.ts': ['sourceId'],
  'ingestion/source-revisions.controller.ts': ['sourceId'],
  'sources/source-catalog.controller.ts': ['sourceId'],
  // Validated by an explicit `z.uuid()` through parseOrBadRequest instead of
  // by a pipe, which produces the same 400.
  'ingestion/extraction-gate.controller.ts': ['id'],
  // The hostile-facing ingress validates the shape itself and answers ONE
  // uniform 403 for every refusal, so it must not use a pipe: a pipe's 400
  // would reintroduce the existence oracle the uniform refusal removed.
  'connectors/webhook.controller.ts': ['connectorId'],
  // Owner erasure's subject (issue #632). This is a Zitadel SUBJECT ID, which
  // is not a uuid and is not ours to shape: every owner column in the schema
  // is `text` for that reason. Demanding a uuid here would refuse the real
  // identifiers this route exists to act on, and it would fail hardest in the
  // case the feature is FOR, where the account is gone and the stored string
  // is all that is left. The route validates what it can instead: the
  // administrator must type the same id twice.
  'memory/erasure.controller.ts': ['userId'],
};

/** Every `*.controller.ts` under project/src, relative to it. */
function controllerFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) controllerFiles(full, acc);
    else if (entry.name.endsWith('.controller.ts')) acc.push(path.relative(SRC, full));
  }
  return acc;
}

describe('controller_id_validation', () => {
  const files = controllerFiles(SRC);

  it('finds the controllers to scan', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('every id-shaped route parameter is validated at the boundary', () => {
    // `@Param('id')` / `@Param('<something>Id')` with no second argument.
    const bare = /@Param\('(id|[a-zA-Z]+Id)'\)/g;
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      const exempt = NOT_A_UUID[file] ?? [];
      for (const match of source.matchAll(bare)) {
        const name = match[1]!;
        if (exempt.includes(name)) continue;
        offenders.push(`${file}: @Param('${name}') has no ParseUUIDPipe`);
      }
    }

    expect(
      offenders,
      'a malformed identifier here reaches Postgres as a uuid comparison and answers 500 ' +
        'instead of 400. Add ParseUUIDPipe, or name the parameter in NOT_A_UUID with its reason.',
    ).toEqual([]);
  });

  it('every exemption names a file that still exists and a parameter it still declares', () => {
    // An exemption that no longer excuses anything is worse than none: it
    // reads as a considered decision while covering nothing.
    for (const [file, params] of Object.entries(NOT_A_UUID)) {
      expect(files, `${file} is exempted but is not a controller any more`).toContain(file);
      const source = readFileSync(path.join(SRC, file), 'utf8');
      for (const param of params) {
        expect(source, `${file} no longer declares @Param('${param}')`).toContain(
          `@Param('${param}')`,
        );
      }
    }
  });
});
