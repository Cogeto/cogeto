/**
 * Confluence storage format to structured plain text (V2.5 item 8.2, issue D1).
 *
 * A Confluence page arrives as "storage format": XHTML with ac: and ri:
 * namespaced elements. This converter produces the text fact extraction reads,
 * under three rules from the decision record (docs/features/confluence.md):
 *
 * 1. **Preserve the structure that carries meaning.** Headings become heading
 *    lines, lists become indented items, and a table row becomes ONE statement
 *    with its column context repeated (`Component: Gateway; Version: 2.4.1`),
 *    the spreadsheet convention from `files/reading/table.ts`, because
 *    specifications live in tables and a naked row extracts as nothing or as
 *    an invention.
 * 2. **Drop noise cleanly.** A macro that renders chrome rather than content
 *    (jira, toc, include, attachments and the rest) emits NOTHING: no
 *    placeholder, no "[macro]" marker a model could turn into a fact.
 * 3. **Fabricate nothing.** No alt text invented for an image, no words made
 *    up for a task's checkbox state, no guessed caption.
 *
 * Zero dependencies by design: the tokenizer is hand rolled and tolerant, and
 * the function never throws. Malformed input degrades to stripping tags and
 * decoding entities rather than failing the page.
 */

interface XmlElement {
  kind: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

interface XmlText {
  kind: 'text';
  text: string;
}

type XmlNode = XmlElement | XmlText;

interface Block {
  text: string;
  /** A code block keeps its internal spacing; everything else is collapsed. */
  verbatim: boolean;
}

/** Elements that never take a close tag, so the tree builder must not wait for one. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'wbr', 'source']);

/** Inline formatting: contributes its text without block spacing around it. */
const INLINE_TAGS = new Set([
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'strike',
  'ins',
  'code',
  'tt',
  'span',
  'sub',
  'sup',
  'small',
  'mark',
  'abbr',
  'a',
  'time',
  'br',
  'ac:link',
  'ac:link-body',
  'ac:structured-macro',
  'ac:macro',
]);

/**
 * Emits nothing, in any position. Images and emoticons per the fabrication
 * rule; parameters, task metadata and plain-text bodies because the handlers
 * that want them read them directly, and reached generically they are chrome.
 */
const DROPPED_TAGS = new Set([
  'ac:image',
  'ac:emoticon',
  'ac:parameter',
  'ac:placeholder',
  'ac:task-status',
  'ac:task-id',
  'ac:plain-text-body',
  'ac:plain-text-link-body',
  'ri:attachment',
  'ri:url',
  'ri:page',
  'ri:space',
  'ri:user',
  'ri:content-entity',
  'style',
  'script',
  'hr',
  'col',
  'colgroup',
  'caption',
]);

/** Containers whose children are blocks of the surrounding flow. */
const TRANSPARENT_TAGS = new Set([
  'div',
  'section',
  'article',
  'main',
  'center',
  'blockquote',
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
  'ac:rich-text-body',
]);

const LIST_TAGS = new Set(['ul', 'ol', 'ac:task-list']);

/** Macros whose rich-text body is content, with an optional title line before it. */
const PANEL_MACROS = new Set([
  'panel',
  'info',
  'note',
  'warning',
  'tip',
  'expand',
  'quote',
  'blockquote',
  'excerpt',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the five named XML entities, nbsp to a plain space, and numeric forms. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return code === 0xa0 ? ' ' : String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const OPEN_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9:_.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/;
const CLOSE_TAG_RE = /^<\/\s*([a-zA-Z][a-zA-Z0-9:_.-]*)/;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g;

/**
 * Tolerant tag tokenizer and tree builder in one pass. A `<` that does not
 * begin a well formed tag is literal text; a close tag with no matching open
 * is ignored; an open tag never closed is closed by the end of input. Nothing
 * here throws on any input.
 */
function parseStorage(input: string): XmlElement {
  const root: XmlElement = { kind: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const top = (): XmlElement => stack[stack.length - 1] ?? root;
  const pushText = (text: string, raw: boolean) => {
    if (text === '') return;
    top().children.push({ kind: 'text', text: raw ? text : decodeEntities(text) });
  };

  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      pushText(input.slice(i), false);
      break;
    }
    if (lt > i) pushText(input.slice(i, lt), false);

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      pushText(input.slice(lt + 9, end === -1 ? input.length : end), true);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<!', lt) || input.startsWith('<?', lt)) {
      const end = input.indexOf('>', lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (input.startsWith('</', lt)) {
      const match = CLOSE_TAG_RE.exec(input.slice(lt));
      const end = input.indexOf('>', lt);
      if (match?.[1] === undefined) {
        pushText('<', false);
        i = lt + 1;
        continue;
      }
      const tag = match[1].toLowerCase();
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth]?.tag === tag) {
          stack.length = depth;
          break;
        }
      }
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const match = OPEN_TAG_RE.exec(input.slice(lt));
    if (match?.[1] === undefined) {
      pushText('<', false);
      i = lt + 1;
      continue;
    }
    const tag = match[1].toLowerCase();
    const rawAttrs = match[2] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.replace(/\/\s*$/, '').matchAll(ATTR_RE)) {
      const name = attr[1]?.toLowerCase();
      if (name === undefined) continue;
      attrs[name] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const element: XmlElement = { kind: 'element', tag, attrs, children: [] };
    top().children.push(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
    i = lt + match[0].length;
  }
  return root;
}

/** Collapses horizontal whitespace runs; newlines (from br) survive. */
function collapseInline(text: string): string {
  return text.replace(/[ \t\u00a0\f\v]+/g, ' ');
}

/** Collapses ALL whitespace to single spaces: cells, headings, list items, titles. */
function collapseFlat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function elementChildren(el: XmlElement): XmlElement[] {
  return el.children.filter((child): child is XmlElement => child.kind === 'element');
}

function findDescendant(el: XmlElement, tag: string): XmlElement | null {
  for (const child of elementChildren(el)) {
    if (child.tag === tag) return child;
    const nested = findDescendant(child, tag);
    if (nested !== null) return nested;
  }
  return null;
}

/** Every text node under the element, concatenated with no reflow. */
function rawText(el: XmlElement): string {
  let out = '';
  for (const child of el.children) {
    out += child.kind === 'text' ? child.text : rawText(child);
  }
  return out;
}

function macroName(el: XmlElement): string {
  return (el.attrs['ac:name'] ?? '').toLowerCase();
}

function parameterText(el: XmlElement, name: string): string {
  for (const child of elementChildren(el)) {
    if (child.tag === 'ac:parameter' && (child.attrs['ac:name'] ?? '').toLowerCase() === name) {
      return collapseFlat(rawText(child));
    }
  }
  return '';
}

/**
 * The link's body text if it has one, else the title of the page it points
 * at, else nothing. The target attribute is the document's own naming of the
 * page, so using it fabricates nothing.
 */
function linkText(el: XmlElement): string {
  const plainBody = findDescendant(el, 'ac:plain-text-link-body');
  if (plainBody !== null) return rawText(plainBody);
  const richBody = findDescendant(el, 'ac:link-body');
  if (richBody !== null) return renderInlineChildren(richBody);
  const page = findDescendant(el, 'ri:page');
  return page?.attrs['ri:content-title'] ?? '';
}

/** A macro reached in inline position: its readable text, or nothing. */
function macroInlineText(el: XmlElement): string {
  const name = macroName(el);
  if (name === 'status') return parameterText(el, 'title');
  const richBody = findDescendant(el, 'ac:rich-text-body');
  if (richBody !== null) return renderInlineChildren(richBody);
  if (name === 'code') {
    const plainBody = findDescendant(el, 'ac:plain-text-body');
    if (plainBody !== null) return rawText(plainBody);
  }
  return '';
}

function renderInline(node: XmlNode): string {
  if (node.kind === 'text') return node.text;
  const el = node;
  if (DROPPED_TAGS.has(el.tag)) return '';
  switch (el.tag) {
    case 'br':
      return '\n';
    case 'time': {
      const text = collapseFlat(renderInlineChildren(el));
      return text !== '' ? text : (el.attrs['datetime'] ?? '');
    }
    case 'ac:link':
      return linkText(el);
    case 'ac:structured-macro':
    case 'ac:macro':
      return macroInlineText(el);
    default:
      return renderInlineChildren(el);
  }
}

/**
 * Flattens children to one text run. A block level child (a paragraph inside
 * a list item or a table cell) is padded with spaces so its words never fuse
 * with its neighbours'; an unknown tag is treated as inline formatting.
 */
function renderInlineChildren(el: XmlElement): string {
  let out = '';
  for (const child of el.children) {
    const rendered = renderInline(child);
    const isBlockChild =
      child.kind === 'element' &&
      !INLINE_TAGS.has(child.tag) &&
      (/^h[1-6]$/.test(child.tag) ||
        child.tag === 'p' ||
        child.tag === 'li' ||
        child.tag === 'tr' ||
        child.tag === 'table' ||
        LIST_TAGS.has(child.tag) ||
        TRANSPARENT_TAGS.has(child.tag));
    out += isBlockChild ? ` ${rendered} ` : rendered;
  }
  return out;
}

/** One list (ul, ol, or a task list) as indented `- ` lines, two spaces per level. */
function renderList(list: XmlElement, depth: number): string[] {
  const itemTag = list.tag === 'ac:task-list' ? 'ac:task' : 'li';
  const lines: string[] = [];
  for (const child of elementChildren(list)) {
    if (LIST_TAGS.has(child.tag)) {
      lines.push(...renderList(child, depth + 1));
      continue;
    }
    if (child.tag !== itemTag) continue;
    const content =
      itemTag === 'ac:task'
        ? (elementChildren(child).find((el) => el.tag === 'ac:task-body')?.children ?? [])
        : child.children;
    const nested: XmlElement[] = [];
    let text = '';
    for (const node of content) {
      if (node.kind === 'element' && LIST_TAGS.has(node.tag)) {
        nested.push(node);
        continue;
      }
      text += ` ${renderInline(node)} `;
    }
    const item = collapseFlat(text);
    if (item !== '') lines.push(`${'  '.repeat(depth)}- ${item}`);
    // An item that is only a container for a deeper list gets no phantom bullet.
    const nestedDepth = item !== '' ? depth + 1 : depth;
    for (const sub of nested) lines.push(...renderList(sub, nestedDepth));
  }
  return lines;
}

function tableRows(table: XmlElement): XmlElement[] {
  const rows: XmlElement[] = [];
  for (const child of elementChildren(table)) {
    if (child.tag === 'tr') rows.push(child);
    if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
      rows.push(...elementChildren(child).filter((el) => el.tag === 'tr'));
    }
  }
  return rows;
}

function rowCells(row: XmlElement): XmlElement[] {
  return elementChildren(row).filter((el) => el.tag === 'th' || el.tag === 'td');
}

function spanOf(cell: XmlElement): number {
  const parsed = Number.parseInt(cell.attrs['colspan'] ?? '1', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 100) : 1;
}

function cellText(cell: XmlElement): string {
  return collapseFlat(renderInlineChildren(cell));
}

/**
 * Header labels with colspan expanded. A spanned label repeats across the
 * columns it covers, so repeats are disambiguated, and only when needed: the
 * first occurrence keeps the label the document wrote.
 */
function headerLabels(cells: XmlElement[]): string[] {
  const expanded: string[] = [];
  for (const cell of cells) {
    const label = cellText(cell);
    for (let k = 0; k < spanOf(cell); k += 1) expanded.push(label);
  }
  const seen = new Map<string, number>();
  return expanded.map((label, index) => {
    const base = label === '' ? `column ${index + 1}` : label;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/**
 * A table as one statement line per data row: `Header: value; ...`, empty
 * cells omitted, all empty rows skipped. The header is the first all-th row,
 * else the first row when others follow it. A headerless table (no th and
 * nothing to sacrifice as labels) gets positional `column N` labels rather
 * than losing its first row to a guess.
 */
function renderTable(table: XmlElement): string[] {
  const rows = tableRows(table);
  const headerIndex = rows.findIndex((row) => {
    const cells = rowCells(row);
    return cells.length > 0 && cells.every((cell) => cell.tag === 'th');
  });

  const headerRow = rows[headerIndex];
  const firstRow = rows[0];
  let labels: string[] = [];
  let dataRows: XmlElement[];
  if (headerRow !== undefined) {
    labels = headerLabels(rowCells(headerRow));
    dataRows = rows.filter((_, index) => index !== headerIndex);
  } else if (
    rows.length > 1 &&
    firstRow !== undefined &&
    rowCells(firstRow).some((cell) => cellText(cell) !== '')
  ) {
    labels = headerLabels(rowCells(firstRow));
    dataRows = rows.slice(1);
  } else {
    dataRows = rows;
  }

  const lines: string[] = [];
  const caption = elementChildren(table).find((el) => el.tag === 'caption');
  if (caption !== undefined) {
    const text = collapseFlat(renderInlineChildren(caption));
    if (text !== '') lines.push(text);
  }
  for (const row of dataRows) {
    const values: string[] = [];
    for (const cell of rowCells(row)) {
      values.push(cellText(cell));
      for (let k = 1; k < spanOf(cell); k += 1) values.push('');
    }
    const parts: string[] = [];
    values.forEach((value, index) => {
      if (value === '') return;
      parts.push(`${labels[index] ?? `column ${index + 1}`}: ${value}`);
    });
    if (parts.length > 0) lines.push(parts.join('; '));
  }
  return lines;
}

/**
 * The macro decision, in block position. Content bearing macros render their
 * content; everything else emits nothing at all. An unknown macro WITH a rich
 * text body renders that body (content over chrome); without one it is chrome
 * and is dropped, placeholder free, per the fabrication rule.
 */
function macroBlocks(el: XmlElement): Block[] {
  const name = macroName(el);
  if (name === 'code') {
    const plainBody = findDescendant(el, 'ac:plain-text-body');
    const body = plainBody === null ? '' : rawText(plainBody);
    return body.trim() === '' ? [] : [{ text: body, verbatim: true }];
  }
  if (name === 'status') {
    const title = parameterText(el, 'title');
    return title === '' ? [] : [{ text: title, verbatim: false }];
  }
  const richBody = findDescendant(el, 'ac:rich-text-body');
  if (PANEL_MACROS.has(name)) {
    const blocks: Block[] = [];
    const title = parameterText(el, 'title');
    if (title !== '') blocks.push({ text: title, verbatim: false });
    if (richBody !== null) blocks.push(...renderBlocks(richBody.children));
    return blocks;
  }
  return richBody === null ? [] : renderBlocks(richBody.children);
}

function renderBlocks(children: XmlNode[]): Block[] {
  const blocks: Block[] = [];
  let run = '';
  const flush = () => {
    const text = collapseInline(run);
    run = '';
    if (text.trim() !== '') blocks.push({ text, verbatim: false });
  };

  for (const node of children) {
    if (node.kind === 'text') {
      run += node.text;
      continue;
    }
    const el = node;
    if (DROPPED_TAGS.has(el.tag)) continue;

    const heading = /^h([1-6])$/.exec(el.tag);
    if (heading?.[1] !== undefined) {
      flush();
      const text = collapseFlat(renderInlineChildren(el));
      if (text !== '')
        blocks.push({ text: `${'#'.repeat(Number(heading[1]))} ${text}`, verbatim: false });
      continue;
    }
    if (el.tag === 'p') {
      flush();
      const text = collapseInline(renderInlineChildren(el));
      if (text.trim() !== '') blocks.push({ text, verbatim: false });
      continue;
    }
    if (LIST_TAGS.has(el.tag)) {
      flush();
      const lines = renderList(el, 0);
      // Item text is already collapsed; verbatim keeps the nesting indent,
      // which the final trim would otherwise strip.
      if (lines.length > 0) blocks.push({ text: lines.join('\n'), verbatim: true });
      continue;
    }
    if (el.tag === 'table') {
      flush();
      const lines = renderTable(el);
      if (lines.length > 0) blocks.push({ text: lines.join('\n'), verbatim: false });
      continue;
    }
    if (el.tag === 'ac:structured-macro' || el.tag === 'ac:macro') {
      flush();
      blocks.push(...macroBlocks(el));
      continue;
    }
    if (el.tag === 'pre') {
      flush();
      const body = rawText(el);
      if (body.trim() !== '') blocks.push({ text: body, verbatim: true });
      continue;
    }
    if (TRANSPARENT_TAGS.has(el.tag)) {
      flush();
      blocks.push(...renderBlocks(el.children));
      continue;
    }
    // Inline formatting, links, and anything unrecognised joins the running
    // text; tolerance means unknown wrapping never deletes readable words.
    run += renderInline(el);
  }
  flush();
  return blocks;
}

/**
 * Deterministic assembly: line ends trimmed, space runs collapsed outside
 * verbatim blocks, at most one blank line between blocks, none at the edges.
 */
function finalize(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    let lines = block.text
      .split('\n')
      .map((line) => (block.verbatim ? line.replace(/[ \t]+$/, '') : collapseInline(line).trim()));
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (!block.verbatim) {
      const kept: string[] = [];
      for (const line of lines) {
        if (line === '' && kept[kept.length - 1] === '') continue;
        kept.push(line);
      }
      lines = kept;
    }
    const text = lines.join('\n');
    if (text !== '') parts.push(text);
  }
  return parts.join('\n\n');
}

/** The give-up path: strip every tag, decode entities, keep the words. */
function stripFallback(storage: string): string {
  const text = storage
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g, '$1')
    .replace(/<[^>]*>/g, ' ');
  const lines = decodeEntities(text)
    .split('\n')
    .map((line) => collapseFlat(line));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

/**
 * Converts one page's storage format to clean structured plain text. Never
 * throws: any failure in the structured path falls back to stripping tags.
 */
export function convertStorageFormat(storage: string): string {
  try {
    const root = parseStorage(storage.replace(/\r\n?/g, '\n'));
    return finalize(renderBlocks(root.children));
  } catch {
    try {
      return stripFallback(storage);
    } catch {
      return '';
    }
  }
}
