import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';

/**
 * Characterization pins for the mailparser → html-to-text conversion that
 * produces `parsed.text` for HTML-only messages (consumed by intake as
 * `textBody` and as the extraction input).
 *
 * The chain underneath is third-party: mailparser → html-to-text →
 * deepmerge-ts, and the root package.json forces deepmerge-ts onto a major
 * html-to-text has not adopted (the CVE-2026-40345 audit override). Nothing in
 * our code calls the merge, so only these output pins can catch the failure
 * mode that matters: options merging silently differently and the rendered
 * text drifting without a crash. If an intentional dependency bump changes
 * this output, review the diff and re-pin; a failure here without a dependency
 * change is a real regression.
 */

const CRLF = '\r\n';

function htmlMessage(subject: string, ...bodyLines: string[]): string {
  return [
    'From: ana@example.hr',
    'To: cogeto@example.hr',
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    ...bodyLines,
  ].join(CRLF);
}

describe('mailparser html-to-text conversion (characterization)', () => {
  it('renders a commercial table email: headings upper-cased, cells joined, link URL bracketed', async () => {
    const parsed = await simpleParser(
      htmlMessage(
        'Ponuda',
        '<h1>Ponuda 42</h1>',
        '<p>Poštovani, u prilogu je <strong>ponuda</strong> za čelične cijevi.</p>',
        '<table><thead><tr><th>Artikl</th><th>Kolicina</th><th>Cijena</th></tr></thead>',
        '<tbody><tr><td>Cijev 3,2 mm</td><td>120</td><td>4,50 €</td></tr>',
        '<tr><td>Cijev 3,4 mm</td><td>80</td><td>5,10 €</td></tr></tbody></table>',
        '<p>Rok isporuke: <a href="https://example.hr/uvjeti">30 dana</a></p>',
      ),
    );
    expect(parsed.text).toBe(
      'PONUDA 42\n\n' +
        'Poštovani, u prilogu je ponuda za čelične cijevi.\n\n' +
        'ArtiklKolicinaCijena Cijev 3,2 mm1204,50 € Cijev 3,4 mm805,10 €\n\n' +
        'Rok isporuke: 30 dana [https://example.hr/uvjeti]',
    );
  });

  it('renders lists, blockquotes and rules: bullets, numbered nesting, "> " quoting, dashed rule', async () => {
    const parsed = await simpleParser(
      htmlMessage(
        'Notes',
        '<h2>Decisions</h2>',
        '<ul><li>Ship v2 <em>next week</em></li><li>Vendors:<ol><li>Alpha</li><li>Beta</li></ol></li></ul>',
        '<blockquote><p>Quoted earlier reply</p></blockquote>',
        '<hr><p>Sig line<br>Second line</p>',
      ),
    );
    expect(parsed.text).toBe(
      'DECISIONS\n\n' +
        ' * Ship v2 next week\n' +
        ' * Vendors:\n' +
        '   1. Alpha\n' +
        '   2. Beta\n\n' +
        '> Quoted earlier reply\n\n' +
        `${'-'.repeat(80)}\n\n` +
        'Sig line\n' +
        'Second line',
    );
  });

  it('never converts when a plain-text part exists: multipart/alternative text arrives verbatim', async () => {
    const parsed = await simpleParser(
      [
        'From: ana@example.hr',
        'To: cogeto@example.hr',
        'Subject: Alt',
        'Content-Type: multipart/alternative; boundary=BB',
        '',
        '--BB',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain part wins, verbatim.',
        '--BB',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML part</p>',
        '--BB--',
      ].join(CRLF),
    );
    expect(parsed.text).toBe('Plain part wins, verbatim.');
    expect(parsed.html).toBe('<p>HTML part</p>');
  });
});
