import { describe, expect, it } from 'vitest';
import { documentIdentityOf } from './document-identity';

/** Issue #498: the identifier fills only where a subject is absent, so the
 * function must be precise about what counts as a numbered document. */
describe('document_identity', () => {
  it('finds identifiers in both corpus languages, verbatim', () => {
    expect(documentIdentityOf('Invoice 2026-0771 includes 12 units of PX-330')).toBe(
      'Invoice 2026-0771',
    );
    expect(documentIdentityOf('The total due on invoice 020260455 is 9666,00')).toBe(
      'invoice 020260455',
    );
    expect(documentIdentityOf('Ponuda 233/01 uključuje 3 KOM AA3133')).toBe('Ponuda 233/01');
    expect(documentIdentityOf('Račun-otpremnica 118-01-261 dospijeva 08.08.2026.')).toBe(
      'Račun-otpremnica 118-01-261',
    );
    expect(documentIdentityOf('Offer 412/02 is valid until 15.08.2026')).toBe('Offer 412/02');
  });

  it('refuses shapes that are not numbered documents', () => {
    expect(documentIdentityOf('The order was confirmed yesterday')).toBeNull();
    expect(documentIdentityOf('Ponuda vrijedi 2 tjedna od datuma ponude')).toBeNull();
    expect(documentIdentityOf('Ana prefers weekly check-ins on Mondays')).toBeNull();
    expect(documentIdentityOf('The invoice 12 people discussed is late')).toBeNull();
  });
});
