import { describe, expect, it } from 'vitest';
import { splitRecipientAlias } from './email-parse';

/**
 * The malformed plus-tag distinction (spaces verification F13): mail to OUR
 * address whose tag cannot be an alias is refused as `alias_not_recognized`,
 * not `wrong_recipient` — the sender plainly tried to name a partition and
 * got it wrong, and the ledger should say which mistake was made. The intake
 * refuses either way; only the recorded reason differs.
 */
describe('recipient_alias_split_names_the_right_mistake', () => {
  const INBOUND = 'capture@in.localhost';

  it('a usable tag is the alias', () => {
    expect(splitRecipientAlias('capture+clientx@in.localhost', INBOUND)).toEqual({
      alias: 'clientx',
    });
  });

  it('the bare address carries no alias and no complaint', () => {
    expect(splitRecipientAlias('capture@in.localhost', INBOUND)).toEqual({ alias: null });
  });

  it('our address with an unusable tag is OURS, marked malformed, never "wrong recipient"', () => {
    expect(splitRecipientAlias('capture+@in.localhost', INBOUND)).toEqual({
      alias: null,
      malformedTag: true,
    });
    expect(splitRecipientAlias('capture+!!!@in.localhost', INBOUND)).toEqual({
      alias: null,
      malformedTag: true,
    });
  });

  it('someone else’s address stays a wrong recipient', () => {
    expect(splitRecipientAlias('someone-else@in.localhost', INBOUND)).toBeNull();
    expect(splitRecipientAlias('capture+tag@elsewhere.example', INBOUND)).toBeNull();
  });
});
