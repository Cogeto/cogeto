import { describe, expect, it } from 'vitest';
import { convertStorageFormat, decodeEntities } from './storage-format';

/**
 * The storage-format converter's contract (V2.5 item 8.2, issue D1): preserve
 * the structure that carries meaning, drop noise cleanly, fabricate nothing,
 * and never throw on malformed input.
 */
describe('headings and paragraphs', () => {
  it('renders headings as # lines and paragraphs as blank-line separated blocks', () => {
    const input =
      '<h1>Release Plan</h1><p>The rollout starts in <strong>March</strong>.</p>' +
      '<h2>Scope</h2><p>Two phases.<br/>One region.</p>';
    expect(convertStorageFormat(input)).toBe(
      '# Release Plan\n\nThe rollout starts in March.\n\n## Scope\n\nTwo phases.\nOne region.',
    );
  });

  it('renders every heading level with its own depth', () => {
    expect(convertStorageFormat('<h3>Three</h3><h6>Six</h6>')).toBe('### Three\n\n###### Six');
  });

  it('flattens inline formatting to plain text', () => {
    const input = '<p>The <em>limit</em> is <code>32</code> <sub>units</sub> <u>net</u>.</p>';
    expect(convertStorageFormat(input)).toBe('The limit is 32 units net.');
  });

  it('keeps link text and drops the target', () => {
    const output = convertStorageFormat(
      '<p>Read <a href="https://x.example/docs">the manual</a> today.</p>',
    );
    expect(output).toBe('Read the manual today.');
    expect(output).not.toContain('https');
  });

  it('uses the datetime of an empty time element and the text of a filled one', () => {
    expect(convertStorageFormat('<p>Due <time datetime="2026-01-15"/>.</p>')).toBe(
      'Due 2026-01-15.',
    );
    expect(convertStorageFormat('<p><time datetime="2026-01-15">next Thursday</time></p>')).toBe(
      'next Thursday',
    );
  });
});

describe('lists', () => {
  it('renders nested lists with two spaces of indent per level', () => {
    const input =
      '<ul><li>alpha<ul><li>alpha one</li><li>alpha two</li></ul></li><li>beta</li></ul>';
    expect(convertStorageFormat(input)).toBe('- alpha\n  - alpha one\n  - alpha two\n- beta');
  });

  it('renders ordered lists as plain items too', () => {
    expect(convertStorageFormat('<ol><li>first</li><li>second</li></ol>')).toBe(
      '- first\n- second',
    );
  });

  it('renders a task list from task bodies without fabricating status words', () => {
    const input =
      '<ac:task-list>' +
      '<ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status>' +
      '<ac:task-body>Ship the beta</ac:task-body></ac:task>' +
      '<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status>' +
      '<ac:task-body><span>Collect survey answers</span></ac:task-body></ac:task>' +
      '</ac:task-list>';
    const output = convertStorageFormat(input);
    expect(output).toBe('- Ship the beta\n- Collect survey answers');
    expect(output).not.toContain('complete');
  });
});

describe('tables', () => {
  const realistic =
    '<h2>Components</h2><table><tbody>' +
    '<tr><th>Component</th><th>Version</th><th>Owner</th></tr>' +
    '<tr><td>Gateway</td><td><strong>2.4.1</strong></td><td>Ana</td></tr>' +
    '<tr><td>Worker</td><td>2.4.0</td><td></td></tr>' +
    '<tr><td></td><td></td><td></td></tr>' +
    '</tbody></table>';

  it('turns each data row into one statement line with column context', () => {
    expect(convertStorageFormat(realistic)).toBe(
      '## Components\n\n' +
        'Component: Gateway; Version: 2.4.1; Owner: Ana\n' +
        'Component: Worker; Version: 2.4.0',
    );
  });

  it('omits empty cells and skips all-empty rows', () => {
    const output = convertStorageFormat(realistic);
    const rows = output.split('\n\n')[1]?.split('\n') ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toContain('Owner');
  });

  it('does not duplicate a preceding heading into the row lines', () => {
    const output = convertStorageFormat(realistic);
    for (const line of output.split('\n').slice(1)) {
      expect(line).not.toContain('Components');
    }
  });

  it('labels a headerless table positionally instead of eating its only row', () => {
    const input = '<table><tbody><tr><td>SN-1001</td><td>2026-01-15</td></tr></tbody></table>';
    expect(convertStorageFormat(input)).toBe('column 1: SN-1001; column 2: 2026-01-15');
  });

  it('falls back to positional labels when the first row carries no text', () => {
    const input =
      '<table><tbody><tr><td/><td/></tr><tr><td>alpha</td><td>7</td></tr></tbody></table>';
    expect(convertStorageFormat(input)).toBe('column 1: alpha; column 2: 7');
  });

  it('uses the first row as the header when no th row exists and data follows', () => {
    const input =
      '<table><tbody><tr><td>Name</td><td>Qty</td></tr>' +
      '<tr><td>Bolt</td><td>40</td></tr></tbody></table>';
    expect(convertStorageFormat(input)).toBe('Name: Bolt; Qty: 40');
  });

  it('expands a header colspan and disambiguates only the repeats', () => {
    const input =
      '<table><tbody><tr><th>Item</th><th colspan="2">Amount</th></tr>' +
      '<tr><td>Bolt M4</td><td>10</td><td>EUR</td></tr></tbody></table>';
    expect(convertStorageFormat(input)).toBe('Item: Bolt M4; Amount: 10; Amount (2): EUR');
  });

  it('emits a caption once, never prefixed onto rows', () => {
    const input =
      '<table><caption>Tolerances</caption><tbody>' +
      '<tr><th>Slot</th><th>Value</th></tr>' +
      '<tr><td>Bore</td><td>3.2 mm</td></tr></tbody></table>';
    expect(convertStorageFormat(input)).toBe('Tolerances\nSlot: Bore; Value: 3.2 mm');
  });
});

describe('macros', () => {
  it('emits a code macro body verbatim, indentation and CDATA angle brackets intact', () => {
    const input =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[function f() {\n  return 1 < 2;\n}]]></ac:plain-text-body>' +
      '</ac:structured-macro>';
    expect(convertStorageFormat(input)).toBe('function f() {\n  return 1 < 2;\n}');
  });

  it('renders a panel title as a line before its converted body', () => {
    const input =
      '<ac:structured-macro ac:name="panel">' +
      '<ac:parameter ac:name="title">Rollout window</ac:parameter>' +
      '<ac:rich-text-body><p>Phase one starts on Monday.</p></ac:rich-text-body>' +
      '</ac:structured-macro>';
    expect(convertStorageFormat(input)).toBe('Rollout window\n\nPhase one starts on Monday.');
  });

  it('renders an expand block the same way', () => {
    const input =
      '<ac:structured-macro ac:name="expand">' +
      '<ac:parameter ac:name="title">Details</ac:parameter>' +
      '<ac:rich-text-body><p>Hidden by default.</p></ac:rich-text-body>' +
      '</ac:structured-macro>';
    expect(convertStorageFormat(input)).toBe('Details\n\nHidden by default.');
  });

  it('renders a status macro as its title text, inline', () => {
    const input =
      '<p>Delivery is <ac:structured-macro ac:name="status">' +
      '<ac:parameter ac:name="colour">Green</ac:parameter>' +
      '<ac:parameter ac:name="title">on track</ac:parameter>' +
      '</ac:structured-macro> for Q3.</p>';
    const output = convertStorageFormat(input);
    expect(output).toBe('Delivery is on track for Q3.');
    expect(output).not.toContain('Green');
  });

  it('drops a jira macro with zero output', () => {
    const input =
      '<ac:structured-macro ac:name="jira">' +
      '<ac:parameter ac:name="key">COG-12</ac:parameter></ac:structured-macro>';
    expect(convertStorageFormat(input)).toBe('');
  });

  it('drops a toc macro without disturbing its neighbours', () => {
    const input = '<p>Intro.</p><ac:structured-macro ac:name="toc"/><p>Body.</p>';
    expect(convertStorageFormat(input)).toBe('Intro.\n\nBody.');
  });

  it('drops view-file, attachments and friends without placeholders', () => {
    const input =
      '<ac:structured-macro ac:name="view-file">' +
      '<ac:parameter ac:name="name">spec.pdf</ac:parameter></ac:structured-macro>' +
      '<ac:structured-macro ac:name="attachments"/>' +
      '<ac:structured-macro ac:name="recently-updated"/>';
    expect(convertStorageFormat(input)).toBe('');
  });

  it('renders the rich body of an unknown macro: content over chrome', () => {
    const input =
      '<ac:structured-macro ac:name="custom-callout">' +
      '<ac:rich-text-body><p>Inner content survives.</p></ac:rich-text-body>' +
      '</ac:structured-macro>';
    expect(convertStorageFormat(input)).toBe('Inner content survives.');
  });

  it('drops an unknown macro without a rich body', () => {
    const input =
      '<ac:structured-macro ac:name="mystery-widget">' +
      '<ac:parameter ac:name="mode">wide</ac:parameter></ac:structured-macro>';
    expect(convertStorageFormat(input)).toBe('');
  });
});

describe('Confluence links, images, emoticons', () => {
  it('uses the target page title when a link has no body text', () => {
    const input = '<p>See <ac:link><ri:page ri:content-title="Deployment Guide"/></ac:link>.</p>';
    expect(convertStorageFormat(input)).toBe('See Deployment Guide.');
  });

  it('prefers the link body text when there is one', () => {
    const input =
      '<p><ac:link><ri:page ri:content-title="X"/>' +
      '<ac:plain-text-link-body><![CDATA[the deployment guide]]></ac:plain-text-link-body>' +
      '</ac:link></p>';
    expect(convertStorageFormat(input)).toBe('the deployment guide');
  });

  it('drops images entirely, alt text and filename included', () => {
    const input =
      '<p>Before <ac:image ac:alt="architecture diagram">' +
      '<ri:attachment ri:filename="arch.png"/></ac:image> after.</p>';
    const output = convertStorageFormat(input);
    expect(output).toBe('Before after.');
    expect(output).not.toContain('architecture');
    expect(output).not.toContain('arch.png');
  });

  it('drops emoticons', () => {
    expect(convertStorageFormat('<p>Done <ac:emoticon ac:name="smile"/> today.</p>')).toBe(
      'Done today.',
    );
  });
});

describe('entities and CDATA', () => {
  it('decodes named entities, nbsp to a plain space, and numeric forms', () => {
    const input = '<p>R&amp;D &#268;akovec &lt;beta&gt; A&nbsp;B &#x2713; done</p>';
    expect(convertStorageFormat(input)).toBe('R&D Čakovec <beta> A B ✓ done');
  });

  it('leaves an unknown entity untouched rather than guessing', () => {
    expect(convertStorageFormat('<p>a &bogus; b</p>')).toBe('a &bogus; b');
  });

  it('handles a CDATA section in ordinary flow', () => {
    expect(convertStorageFormat('<p><![CDATA[5 < 6 && x > 2]]></p>')).toBe('5 < 6 && x > 2');
  });

  it('decodes entities inside attribute values', () => {
    const input = '<p><ac:link><ri:page ri:content-title="Q&amp;A"/></ac:link></p>';
    expect(convertStorageFormat(input)).toBe('Q&A');
  });

  it('exposes the entity decoder for reuse', () => {
    expect(decodeEntities('&lt;&amp;&gt;&quot;&apos;&nbsp;&#65;&#x42;')).toBe('<&>"\' AB');
  });
});

describe('malformed input never throws', () => {
  it('reads through unclosed tags', () => {
    expect(convertStorageFormat('<p>alpha <strong>beta')).toBe('alpha beta');
  });

  it('treats stray angle brackets as text', () => {
    expect(convertStorageFormat('<p>value < 10 and > 5</p>')).toBe('value < 10 and > 5');
    expect(convertStorageFormat('text with <<< stray brackets')).toBe(
      'text with <<< stray brackets',
    );
  });

  it('survives tag soup and still yields text', () => {
    const soup = '</div><table><tr><td>a</tr></table><ul><li>x';
    expect(() => convertStorageFormat(soup)).not.toThrow();
    const output = convertStorageFormat(soup);
    expect(output).toContain('a');
    expect(output).toContain('- x');
  });

  it('survives a truncated CDATA section and a truncated comment', () => {
    expect(convertStorageFormat('<p>ok</p><!-- cut off')).toBe('ok');
    expect(convertStorageFormat('<p><![CDATA[kept to the end')).toBe('kept to the end');
  });
});

describe('whitespace and determinism', () => {
  it('normalizes CRLF input', () => {
    expect(convertStorageFormat('<p>one</p>\r\n<p>two</p>')).toBe('one\n\ntwo');
  });

  it('collapses space runs and drops empty paragraphs', () => {
    expect(convertStorageFormat('<p></p><p>   </p><p>Real   text  here.</p><p></p>')).toBe(
      'Real text here.',
    );
  });

  it('never emits leading or trailing blank lines or double blanks', () => {
    const output = convertStorageFormat('\n\n<p>a</p>\n\n\n<p>b</p>\n\n');
    expect(output).toBe('a\n\nb');
    expect(output).not.toMatch(/\n{3}/);
  });

  it('is deterministic: the same input converts identically every time', () => {
    const input =
      '<h1>Spec</h1><p>Intro &amp; scope.</p>' +
      '<table><tbody><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></tbody></table>' +
      '<ac:structured-macro ac:name="code"><ac:plain-text-body>' +
      '<![CDATA[x = 1]]></ac:plain-text-body></ac:structured-macro>' +
      '<ul><li>one<ul><li>two</li></ul></li></ul>';
    expect(convertStorageFormat(input)).toBe(convertStorageFormat(input));
  });
});
