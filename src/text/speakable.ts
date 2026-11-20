import MarkdownIt from 'markdown-it';
import { closeSentence, splitSentences } from './sentences';

/**
 * Turns Claude's Markdown into text written for the ear: code blocks announced instead of read,
 * file paths shortened to the file name, links reduced to their text, tables summarized, emoji
 * dropped and symbols said as words.
 */

export interface SpeakOptions {
  codeBlocks: 'announce' | 'skip' | 'read';
  tables: 'announce' | 'rows' | 'skip';
  paths: 'fileName' | 'full';
  longReplies: 'full' | 'firstParagraph';
  longReplyLength: number;
}

export const defaultSpeakOptions: SpeakOptions = {
  codeBlocks: 'announce',
  tables: 'announce',
  paths: 'fileName',
  longReplies: 'full',
  longReplyLength: 1500,
};

export type BlockKind = 'heading' | 'paragraph' | 'item' | 'quote' | 'code' | 'table' | 'note';

export interface SpokenBlock {
  kind: BlockKind;
  text: string;
}

type Token = ReturnType<MarkdownIt['parse']>[number];

const md = new MarkdownIt({ html: true, linkify: true });

export function speakableBlocks(markdown: string, options: Partial<SpeakOptions> = {}): SpokenBlock[] {
  const o = { ...defaultSpeakOptions, ...options };
  const tokens = md.parse(markdown, {});
  const blocks: SpokenBlock[] = [];
  const add = (kind: BlockKind, text: string) => {
    const t = tidy(text);
    if (t) blocks.push({ kind, text: closeSentence(t) });
  };

  let inItem = 0;
  let inQuote = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'list_item_open': inItem++; break;
      case 'list_item_close': inItem--; break;
      case 'blockquote_open': inQuote++; break;
      case 'blockquote_close': inQuote--; break;
      case 'heading_open':
        add('heading', inline(tokens[i + 1], o));
        i += 2;
        break;
      case 'paragraph_open':
        add(inItem ? 'item' : inQuote ? 'quote' : 'paragraph', inline(tokens[i + 1], o));
        i += 2;
        break;
      case 'fence':
      case 'code_block':
        if (o.codeBlocks === 'announce') add('code', announceCode(t.info, t.content));
        else if (o.codeBlocks === 'read') add('code', t.content.split('\n').map((l) => l.trim()).filter(Boolean).join('. '));
        break;
      case 'table_open': {
        const close = tokens.findIndex((x, j) => j > i && x.type === 'table_close');
        const table = readTable(tokens.slice(i, close), o);
        if (o.tables === 'announce') add('table', announceTable(table));
        else if (o.tables === 'rows') add('table', tableRows(table));
        i = close;
        break;
      }
      case 'html_block':
        add(inItem ? 'item' : 'paragraph', normalize(t.content.replace(/<[^>]+>/g, ' ')));
        break;
    }
  }

  if (o.longReplies === 'firstParagraph' && blocks.reduce((n, b) => n + b.text.length, 0) > o.longReplyLength) {
    return firstParagraph(blocks);
  }
  return blocks;
}

/** The whole reply as speakable text, one block per paragraph (for "Show What Will Be Read"). */
export function speakableText(markdown: string, options: Partial<SpeakOptions> = {}): string {
  return speakableBlocks(markdown, options).map((b) => b.text).join('\n\n');
}

/**
 * Text that isn't Markdown, such as a selection in a code or text file, read as written.
 * - Code: line by line, untouched. The rules for prose would misread it ("5 - 3" isn't "5 to 3").
 * - Prose: paragraph by paragraph, each list item on its own, with emoji dropped and symbols said as
 *   words, as in replies.
 */
export function plainBlocks(text: string, kind: 'prose' | 'code'): SpokenBlock[] {
  const pieces = kind === 'code'
    ? text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim())
    : proseParagraphs(text).map((p) => tidy(normalize(p)));
  return pieces.filter(Boolean).map((t): SpokenBlock => ({ kind: 'paragraph', text: closeSentence(t) }));
}

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/** Paragraphs of a text file: blank lines separate them, and so does a line that starts a list item. */
function proseParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let current = '';
    for (const line of paragraph.split('\n')) {
      if (current && LIST_ITEM.test(line)) {
        out.push(current);
        current = '';
      }
      current += (current ? ' ' : '') + line.replace(/^\s*[-*+•]\s+/, ''); // a bullet isn't said; a number is
    }
    out.push(current);
  }
  return out;
}

/** Keeps the first paragraph (and any headings before it), then the closing question, if any. */
function firstParagraph(blocks: SpokenBlock[]): SpokenBlock[] {
  const first = blocks.findIndex((b) => b.kind !== 'heading');
  if (first < 0 || first === blocks.length - 1) return blocks;
  const kept = blocks.slice(0, first + 1);
  kept.push({ kind: 'note', text: 'The rest is on screen.' });
  const last = blocks[blocks.length - 1];
  const question = splitSentences(last.text).pop();
  if (question?.endsWith('?')) kept.push({ kind: last.kind, text: question });
  return kept;
}

// ---- inline text ----------------------------------------------------------------------------

function inline(token: Token | undefined, o: SpeakOptions): string {
  const children = token?.children ?? [];
  let out = '';
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    switch (c.type) {
      case 'text':
        out += normalize(c.content);
        break;
      case 'code_inline':
        out += speakCode(c.content, o);
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      case 'image':
        out += c.content ? ` image: ${normalize(c.content)} ` : ' an image ';
        break;
      case 'link_open': {
        const href = c.attrGet('href') ?? '';
        const close = children.findIndex((x, j) => j > i && x.type === 'link_close');
        const inner = children.slice(i + 1, close < 0 ? undefined : close);
        const label = inner.map((x) => x.content).join('').trim();
        out += speakLink(label, href, inner, o);
        if (close > 0) i = close;
        break;
      }
      case 'html_inline':
        if (/^<br\s*\/?>$/i.test(c.content)) out += ' '; // a line break: "API.<br>Press" isn't one word
        break; // other tags carry nothing worth saying
      default:
        break; // emphasis and strike markers
    }
  }
  return out;
}

function speakLink(label: string, href: string, inner: Token[], o: SpeakOptions): string {
  const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(href);
  if (!label || label === href || label === href.replace(/^mailto:/, '')) {
    return isUrl ? linkTo(href) : speakPath(href, o);
  }
  if (inner.length === 1 && inner[0].type === 'code_inline') return speakCode(label, o);
  if (!isUrl && looksLikePath(label)) return speakPath(label, o);
  if (/^https?:\/\//i.test(label)) return linkTo(label);
  return normalize(label);
}

function linkTo(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'mailto:') return ` an email address `;
    return ` a link to ${u.hostname.replace(/^www\./, '')} `;
  } catch {
    return ' a link ';
  }
}

const PATH_LIKE = /^(?:[A-Za-z]:)?[\\/]?(?:[\w@~.+-]+[\\/])+[\w@~.+ -]*?(?::\d+(?:[:-]\d+)?)?$/;
const FILE_LIKE = /^[\w@~+-][\w.@~+-]*\.[A-Za-z][\w]{0,7}(?::\d+(?:[:-]\d+)?)?$/;

function looksLikePath(s: string): boolean {
  return PATH_LIKE.test(s) || FILE_LIKE.test(s);
}

function speakPath(p: string, o: SpeakOptions): string {
  const m = /^(.*?)(?::(\d+)(?:[:-](\d+))?)?$/.exec(p.trim())!;
  let name = m[1];
  if (o.paths === 'fileName') name = name.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || name;
  else name = name.replace(/[\\/]+/g, ' slash ').trim();
  let spoken = name;
  if (m[2]) spoken += m[3] ? `, lines ${m[2]} to ${m[3]}` : `, line ${m[2]}`;
  return ` ${spoken} `;
}

function speakCode(code: string, o: SpeakOptions): string {
  const c = code.trim();
  if (!c) return '';
  if (looksLikePath(c) && !/\s/.test(c)) return speakPath(c, o);
  if (/^https?:\/\/\S+$/i.test(c)) return linkTo(c);
  // a command-line flag: --no-dependencies -> "no dependencies"
  if (/^--?[A-Za-z][\w-]*$/.test(c)) return ` ${c.replace(/^-+/, '').replace(/[-_]+/g, ' ')} `;
  // an identifier: stop_reason -> "stop reason"
  if (/^\w+$/.test(c) && c.includes('_')) return ` ${c.replace(/_+/g, ' ').trim()} `;
  return ` ${c} `;
}

// ---- symbols and units --------------------------------------------------------------------

// Units written right after a number ("250ms", "100 MB"). Bare s, h and min need a space before
// them, so "1990s" and "MP3s" stay as they are.
const UNITS: Record<string, [string, string]> = {
  ms: ['millisecond', 'milliseconds'], s: ['second', 'seconds'], sec: ['second', 'seconds'],
  min: ['minute', 'minutes'], h: ['hour', 'hours'], KB: ['kilobyte', 'kilobytes'], MB: ['megabyte', 'megabytes'],
  GB: ['gigabyte', 'gigabytes'], TB: ['terabyte', 'terabytes'], px: ['pixel', 'pixels'], Hz: ['hertz', 'hertz'],
  kHz: ['kilohertz', 'kilohertz'], fps: ['frame per second', 'frames per second'],
};
const unit = (n: string, u: string) => `${n} ${UNITS[u][n === '1' ? 0 : 1]}`;
// The whole number before a unit ("16,731 ms" is many milliseconds, not one).
const NUMBER = String.raw`(?<![\d.,])(\d+(?:[.,]\d+)*)`;
const UNIT_AFTER = new RegExp(`${NUMBER}\\s?(ms|sec|KB|MB|GB|TB|px|kHz|Hz|fps)\\b`, 'g');
const SHORT_UNIT_AFTER = new RegExp(`${NUMBER} (s|h|min)\\b`, 'g');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

export function normalize(text: string): string {
  return text
    // symbols that mean something become words, before decorative ones are dropped
    .replace(/[✓✔]️?/g, ' yes ')
    .replace(/[✗✘]️?/g, ' no ')
    .replace(/⚠️?\s*/g, 'warning, ')
    .replace(/\s*(?:→|->|⇒)\s*/g, ' to ')
    .replace(/\s*←\s*/g, ' from ')
    .replace(/\s*↔\s*/g, ' and ')
    .replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, '')
    .replace(/[☀-➿️‍]/g, '')
    // dates and numbers
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) =>
      +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${MONTHS[+mo - 1]} ${+d}, ${y}` : m)
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/(\d) - (\d)/g, '$1 to $2')
    .replace(/(\d)\s*[×x]\s*(\d)/g, '$1 by $2')
    .replace(/(\d)\s?[×x](?![\w])/g, '$1 times')
    .replace(/≥\s*(\d)/g, 'at least $1')
    .replace(/≤\s*(\d)/g, 'at most $1')
    .replace(/≥/g, ' greater than or equal to ')
    .replace(/≤/g, ' less than or equal to ')
    .replace(/≈\s*/g, 'about ')
    .replace(/~\s*(\d)/g, 'about $1')
    .replace(/±\s*/g, 'plus or minus ')
    .replace(UNIT_AFTER, (_m, n: string, u: string) => unit(n, u))
    .replace(SHORT_UNIT_AFTER, (_m, n: string, u: string) => unit(n, u))
    // punctuation that reads badly
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/…/g, '...')
    .replace(/\s&\s/g, ' and ')
    .replace(/[|•▪◦]/g, ' ');
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[,;:\s]+/, '')
    .trim();
}

// ---- code blocks and tables -----------------------------------------------------------------

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript',
  jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON', jsonc: 'JSON', jsonl: 'JSON',
  py: 'Python', python: 'Python', sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  ps1: 'PowerShell', powershell: 'PowerShell', pwsh: 'PowerShell', cmd: 'command prompt', bat: 'batch',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  md: 'Markdown', markdown: 'Markdown', diff: 'diff', go: 'Go', rust: 'Rust', rs: 'Rust', java: 'Java',
  kotlin: 'Kotlin', kt: 'Kotlin', swift: 'Swift', c: 'C', cpp: 'C++', cs: 'C#', csharp: 'C#', php: 'PHP',
  ruby: 'Ruby', rb: 'Ruby', dart: 'Dart', lua: 'Lua', r: 'R', dockerfile: 'Dockerfile', ini: 'INI',
};

function announceCode(info: string, content: string): string {
  const lang = LANGUAGES[(info.trim().split(/\s+/)[0] ?? '').toLowerCase()] ?? '';
  const lines = content.replace(/\n+$/, '').split('\n').length;
  const count = lines === 1 ? 'one line' : `${lines} lines`;
  if (lines === 1 && (lang === 'shell' || lang === 'PowerShell' || lang === 'command prompt')) {
    return lang === 'shell' ? 'A shell command.' : `A ${lang} command.`;
  }
  if (lang === 'diff') return `A diff, ${count}.`;
  if (!lang) return `A code block, ${count}.`;
  return `${lang} code, ${count}.`;
}

interface Table { header: string[]; rows: string[][] }

function readTable(tokens: Token[], o: SpeakOptions): Table {
  const header: string[] = [];
  const rows: string[][] = [];
  let row: string[] | undefined;
  let inHead = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'thead_open') inHead = true;
    else if (t.type === 'thead_close') inHead = false;
    else if (t.type === 'tr_open') row = [];
    else if (t.type === 'tr_close' && row) {
      if (inHead) header.push(...row);
      else rows.push(row);
      row = undefined;
    } else if (t.type === 'inline' && row) row.push(tidy(inline(t, o)));
  }
  return { header, rows };
}

function listNames(names: string[]): string {
  const shown = names.filter(Boolean).slice(0, 6);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function announceTable(t: Table): string {
  const cols = t.header.length;
  const rows = t.rows.length;
  const colText = cols === 1 ? 'one column' : `${cols} columns`;
  const rowText = rows === 1 ? 'one row' : `${rows} rows`;
  return cols ? `A table with ${colText}, ${listNames(t.header)}, and ${rowText}.` : `A table with ${rowText}.`;
}

function tableRows(t: Table): string {
  const shown = t.rows.slice(0, 20).map((r) =>
    r.map((cell, i) => (t.header[i] ? `${t.header[i]}: ${cell}` : cell)).filter((c) => c.trim()).join(', '),
  );
  const more = t.rows.length - shown.length;
  return [`A table.`, ...shown.map((r) => closeSentence(r)), more > 0 ? `And ${more} more rows.` : '']
    .filter(Boolean)
    .join(' ');
}
