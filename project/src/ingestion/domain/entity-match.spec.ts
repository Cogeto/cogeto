import { describe, expect, it } from 'vitest';
import {
  canonicalEntityOverlap,
  entityNamesMatch,
  EntityAliasIndex,
  foldEntityName,
  isOneMidTokenEdit,
} from './entity-match';

describe('foldEntityName', () => {
  it('folds case, punctuation, whitespace and diacritics', () => {
    expect(foldEntityName('  Adriatic-Foods  ')).toBe('adriatic foods');
    expect(foldEntityName('ADRIATIC   FOODS')).toBe('adriatic foods');
    expect(foldEntityName('Jadranska hrana')).toBe('jadranska hrana');
    expect(foldEntityName('Šibenik Čelik đir')).toBe('sibenik celik dir');
    expect(foldEntityName('Müller & Söhne')).toBe('muller and sohne');
  });

  it('strips legal-form suffixes, in both conventions', () => {
    expect(foldEntityName('Adriatic Foods d.o.o.')).toBe('adriatic foods');
    expect(foldEntityName('Jadranska hrana d.d.')).toBe('jadranska hrana');
    expect(foldEntityName('Acme GmbH')).toBe('acme');
    expect(foldEntityName('Acme Ltd')).toBe('acme');
    expect(foldEntityName('Acme LLC')).toBe('acme');
  });

  it('never strips a name down to nothing', () => {
    expect(foldEntityName('AG')).toBe('ag');
    expect(foldEntityName('d.o.o.')).toBe('doo');
  });

  it('is total on empty input', () => {
    expect(foldEntityName('')).toBe('');
    expect(foldEntityName('   ')).toBe('');
  });
});

describe('EntityAliasIndex', () => {
  const index = new EntityAliasIndex([
    { canonical: 'Adriatic Foods', alias: 'Jadranska hrana' },
    { canonical: 'Jadranska hrana', alias: 'AF Group' },
  ]);

  it('resolves alias-connected names to one key, transitively', () => {
    expect(index.keyOf('Adriatic Foods d.o.o.')).toBe(index.keyOf('Jadranska hrana'));
    expect(index.keyOf('AF Group')).toBe(index.keyOf('Adriatic Foods'));
  });

  it('leaves unrelated names on their own fold', () => {
    expect(index.keyOf('Dinara Steel')).toBe('dinara steel');
  });

  it('expands a name to every recorded equivalent', () => {
    const expanded = index.expand('Adriatic Foods');
    expect(expanded).toContain('jadranska hrana');
    expect(expanded).toContain('af group');
    expect(expanded).toContain('adriatic foods');
  });
});

describe('isOneMidTokenEdit (the typo rule)', () => {
  it('accepts a single mid-token edit in a long name', () => {
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic fods')).toBe(true); // deletion
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic fouods')).toBe(true); // insertion
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic fbods')).toBe(true); // substitution
  });

  it('refuses token-initial differences: those are different names', () => {
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic goods')).toBe(false);
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic oods')).toBe(false);
  });

  it('refuses digit edits: sibling model numbers are different products', () => {
    expect(isOneMidTokenEdit('pwr 3100', 'pwr 3200')).toBe(false);
    expect(isOneMidTokenEdit('vx 900 rev', 'vx 9000 rev')).toBe(false);
    expect(isOneMidTokenEdit('pwr 3100', 'pwr 310')).toBe(false);
  });

  it('refuses short names outright: one edit in a short name is a new name', () => {
    expect(isOneMidTokenEdit('marko', 'mirko')).toBe(false);
    expect(isOneMidTokenEdit('ana', 'ann')).toBe(false);
  });

  it('refuses more than one edit and identity', () => {
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic foods')).toBe(false);
    expect(isOneMidTokenEdit('adriatic foods', 'adriatic fdos')).toBe(false);
  });
});

describe('entityNamesMatch', () => {
  const aliases = new EntityAliasIndex([{ canonical: 'Adriatic Foods', alias: 'Jadranska hrana' }]);

  it('matches across the alias set, cross-language included', () => {
    expect(entityNamesMatch('Adriatic Foods d.o.o.', 'Jadranska hrana', aliases)).toBe(true);
  });

  it('matches folded variants without any alias', () => {
    expect(entityNamesMatch('ADRIATIC FOODS', 'adriatic-foods d.o.o.')).toBe(true);
  });

  it('does not match genuinely different companies', () => {
    expect(entityNamesMatch('Adriatic Foods', 'Adria Foods', aliases)).toBe(false);
    expect(entityNamesMatch('Adriatic Foods', 'Adriatic Goods', aliases)).toBe(false);
  });

  it('is null-safe', () => {
    expect(entityNamesMatch(null, 'x')).toBe(false);
    expect(entityNamesMatch('x', undefined)).toBe(false);
  });
});

describe('canonicalEntityOverlap', () => {
  const aliases = new EntityAliasIndex([{ canonical: 'Adriatic Foods', alias: 'Jadranska hrana' }]);

  it('counts alias-equivalent names as shared', () => {
    expect(canonicalEntityOverlap(['Adriatic Foods', 'Marko'], ['Jadranska hrana'], aliases)).toBe(
      1,
    );
  });

  it('is 0 when either side folds to nothing', () => {
    expect(canonicalEntityOverlap([], ['x'], aliases)).toBe(0);
  });
});
