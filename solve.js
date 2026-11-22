// Velox — a fast drop-in for makefun-site 1.0.0.
//
// Same answers as the reference, byte for byte, on every case; written from
// the README's rules with the slow parts rebuilt: one line split per source
// shared by front matter and Markdown, Markdown rendered straight to text
// with no token objects, slugs on a plain ASCII fast path, and templates
// walked with their loop bindings resolved at parse time instead of by a
// scope-chain search on every variable.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Slug of `text`: NFKD, marks dropped, runs of non [a-z0-9] become one `-`, cut at 64. */
function slugify(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, '');
  else out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_BLANK = /^[ \t]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value, or { error }. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * Front matter over a source's lines: { data, bodyStart } or { error }.
 * The first failing line is the one reported, in the reference's order.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RE = /\s/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  return (c === 32 || c === 9) && BLANK_RE.test(line);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 96) return FENCE_OPEN.test(line); // '`'
  if (c === 45 || c === 42) return HR_RE.test(line); // '-' or '*'
  if (c === 32 || c === 9 || Number.isNaN(c)) return isBlank(line);
  return false;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Index of the next inline-special character at or after `from`, or -1. */
function nextSpecial(s, from) {
  let n = -1;
  for (const ch of ['\\', '`', '*', '[']) {
    const j = s.indexOf(ch, from);
    if (j !== -1 && (n === -1 || j < n)) n = j;
  }
  return n;
}

/** `s` rendered inline, appended to `out`; `link(target)` resolves a link target. */
function inlineInto(s, link, out) {
  let i = 0;
  for (;;) {
    const n = nextSpecial(s, i);
    if (n === -1) {
      if (i < s.length) out.push(esc(s.slice(i)));
      return;
    }
    if (n > i) out.push(esc(s.slice(i, n)));
    const c = s[n];
    if (c === '\\') {
      if (n + 1 < s.length && ESCAPABLE.has(s[n + 1])) {
        out.push(esc(s[n + 1]));
        i = n + 2;
      } else {
        out.push('\\');
        i = n + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', n + 1);
      if (j > n + 1) {
        out.push('<code>', esc(s.slice(n + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i = n + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[n + 1] === '*') {
        const j = findUnescaped(s, '**', n + 2);
        if (j > n + 2) {
          out.push('<strong>');
          inlineInto(s.slice(n + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i = n + 2;
        }
        continue;
      }
      const j = findSingleStar(s, n + 1);
      if (j > n + 1) {
        out.push('<em>');
        inlineInto(s.slice(n + 1, j), link, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i = n + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', n + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out.push('<a href="', esc(link(target)), '">');
      inlineInto(s.slice(n + 1, k), link, out);
      out.push('</a>');
      i = m + 1;
      continue;
    }
    out.push('[');
    i = n + 1;
  }
}

/**
 * A body's lines rendered straight to HTML: { html, toc, excerpt }.
 * `lines` is the source's whole line array, the body starting at `start`.
 */
function renderMarkdown(lines, start, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    }
    const fence = c0 === 96 ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`;
      let code = '';
      for (const l of body) code += `${esc(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const out = [];
      inlineInto(heading.text, link, out);
      const html = out.join('');
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR_RE.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const out = [];
        inlineInto(kept.join('\n'), link, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>`);
      }
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? BULLET_RE.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const startNum = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) {
        const out = [];
        inlineInto(parts.join('\n'), link, out);
        html += `<li>${out.join('')}</li>\n`;
      }
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const out = [];
    inlineInto(body.join('\n'), link, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * How far up the runtime frame stack a path's first name sits: 0 is the
 * innermost loop frame, -1 means "not bound by this template's own loops",
 * so the renderer walks the frames and then the page's values.
 */
function resolveFirst(path, scopes) {
  const name = path[0];
  if (name === 'loop') return scopes.length === 0 ? -1 : 0;
  for (let d = scopes.length - 1, depth = 0; d >= 0; d--, depth++) {
    if (scopes[d] === name) return depth;
  }
  return -1;
}

/** `src` tokenised: text, {{ }}, {{{ }}} and {% %}, standalone tags' lines taken. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * One stretch of tokens parsed into nodes. `closer` is the tag that ends
 * this stretch: null at the root, 'for' in a loop, 'if-then' / 'if-else'
 * in a conditional. Returns { body, end } where end is the closing tag
 * met, or null at the end of the tokens.
 */
function parseSeq(name, toks, pos, scopes, closer) {
  const body = [];
  while (pos.i < toks.length) {
    const tok = toks[pos.i++];
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path, resD: resolveFirst(tok.path, scopes) });
      continue;
    }
    const tag = tok.tag;
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const path = pathOf(name, m[2]);
      const node = { kind: 'for', name: m[1], path, resD: resolveFirst(path, scopes), body: null };
      scopes.push(m[1]);
      const r = parseSeq(name, toks, pos, scopes, 'for');
      scopes.pop();
      if (r.end !== 'endfor') throw new TemplateError(`template "${name}": a for is not closed`);
      node.body = r.body;
      body.push(node);
      continue;
    }
    if ((m = IF_RE.exec(tag)) !== null) {
      const path = pathOf(name, m[2]);
      const node = { kind: 'if', not: m[1] !== undefined, path, resD: resolveFirst(path, scopes), then: null, else: null };
      const r1 = parseSeq(name, toks, pos, scopes, 'if-then');
      node.then = r1.body;
      if (r1.end === 'else') {
        const r2 = parseSeq(name, toks, pos, scopes, 'if-else');
        node.else = r2.body;
        if (r2.end !== 'endif') throw new TemplateError(`template "${name}": a if is not closed`);
      } else if (r1.end !== 'endif') {
        throw new TemplateError(`template "${name}": a if is not closed`);
      }
      body.push(node);
      continue;
    }
    if (tag === 'else') {
      if (closer !== 'if-then') throw new TemplateError(`template "${name}": an else outside an if`);
      return { body, end: 'else' };
    }
    if (tag === 'endfor') {
      if (closer !== 'for') throw new TemplateError(`template "${name}": an endfor with no open for`);
      return { body, end: 'endfor' };
    }
    if (tag === 'endif') {
      if (closer !== 'if-then' && closer !== 'if-else') throw new TemplateError(`template "${name}": an endif with no open if`);
      return { body, end: 'endif' };
    }
    if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
      continue;
    }
    throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  return { body, end: null };
}

/** `src` parsed into its node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const pos = { i: 0 };
  return parseSeq(name, tokenize(name, src), pos, [], null).body;
}

/** The value at `path`: first name from the frames, then the page's values. */
function lookup(frames, topVars, path, resD) {
  let v;
  if (resD >= 0) {
    v = frames[frames.length - 1 - resD][path[0]];
  } else {
    let found = false;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (Object.hasOwn(frames[i], path[0])) {
        v = frames[i][path[0]];
        found = true;
        break;
      }
    }
    if (!found) {
      if (!Object.hasOwn(topVars, path[0])) return undefined;
      v = topVars[path[0]];
    }
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out`, in the frame stack and the page's values. */
function renderNodes(nodes, frames, topVars, templates, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(frames, topVars, n.path, n.resD))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, topVars, n.path, n.resD)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, topVars, n.path, n.resD));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, topVars, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, topVars, n.path, n.resD);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const frame = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          frames.push(frame);
          renderNodes(n.body, frames, topVars, templates, depth, out);
          frames.pop();
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, frames, topVars, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template codegen
//
// A parsed template also compiles to a plain function that appends to the
// output array directly: no node dispatch, no scope-chain walk, loop
// bindings as locals. The tree walker above stays as the fallback when a
// template cannot be compiled (a sandbox that refuses generated code, for
// instance): the answers are the same either way.

/** Dynamic lookup for a path no loop of this template binds. */
function lookupDyn(frames, topVars, path) {
  let v;
  let found = false;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (Object.hasOwn(frames[i], path[0])) {
      v = frames[i][path[0]];
      found = true;
      break;
    }
  }
  if (!found) {
    if (!Object.hasOwn(topVars, path[0])) return undefined;
    v = topVars[path[0]];
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** An include inside compiled code: the template at its depth, or nothing. */
function incTpl(templates, name, frames, topVars, depth, out, escFn, textOfFn, truthyFn, lookupDynFn, incTplFn) {
  if (depth >= 8) return;
  const fn = templates.get(name);
  if (fn === undefined) return;
  fn(frames, topVars, templates, depth + 1, out, escFn, textOfFn, truthyFn, lookupDynFn, incTplFn);
}

let __uid = 0;

/** Statements that put the value at `path` into a fresh temp; returns its name. */
function genValue(path, resD, stmts) {
  const v = `__v${__uid++}`;
  if (resD >= 0) {
    stmts.push(`let ${v} = frames[frames.length - ${1 + resD}][${JSON.stringify(path[0])}];`);
    for (let k = 1; k < path.length; k++) {
      stmts.push(`if (${v} !== null && typeof ${v} === 'object' && Object.hasOwn(${v}, ${JSON.stringify(path[k])})) ${v} = ${v}[${JSON.stringify(path[k])}]; else ${v} = undefined;`);
    }
    return v;
  }
  stmts.push(`let ${v} = lookupDyn(frames, topVars, ${JSON.stringify(path)});`);
  return v;
}

/** `nodes` compiled to statements appending to `out`. */
function genNodes(nodes, stmts) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        stmts.push(`out.push(${JSON.stringify(n.text)});`);
        break;
      case 'var': {
        const v = genValue(n.path, n.resD, stmts);
        stmts.push(`out.push(esc(textOf(${v})));`);
        break;
      }
      case 'raw': {
        const v = genValue(n.path, n.resD, stmts);
        stmts.push(`out.push(textOf(${v}));`);
        break;
      }
      case 'if': {
        const v = genValue(n.path, n.resD, stmts);
        stmts.push(`if (truthy(${v}) !== ${n.not}) {`);
        genNodes(n.then, stmts);
        if (n.else !== null) {
          stmts.push('} else {');
          genNodes(n.else, stmts);
        }
        stmts.push('}');
        break;
      }
      case 'for': {
        const xs = genValue(n.path, n.resD, stmts);
        const k = `__k${__uid++}`;
        stmts.push(`if (Array.isArray(${xs})) { for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) { frames.push({ ${JSON.stringify(n.name)}: ${xs}[${k}], loop: { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${xs}.length - 1, length: ${xs}.length } });`);
        genNodes(n.body, stmts);
        stmts.push('frames.pop(); } }');
        break;
      }
      case 'include':
        stmts.push(`incTpl(templates, ${JSON.stringify(n.name)}, frames, topVars, depth, out, esc, textOf, truthy, lookupDyn, incTpl);`);
        break;
    }
  }
}

/** A parsed template as a function, or null when it cannot be compiled. */
function compileTemplate(nodes) {
  __uid = 0;
  const stmts = [];
  genNodes(nodes, stmts);
  try {
    return new Function('frames', 'topVars', 'templates', 'depth', 'out', 'esc', 'textOf', 'truthy', 'lookupDyn', 'incTpl', stmts.join('\n'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

/** The words of a body's lines, counted line by line (a line break is whitespace, as in the joined body). */
function wordsOfLines(lines, start) {
  let n = 0;
  const re = /\S+/g;
  for (let i = start; i < lines.length; i++) {
    re.lastIndex = 0;
    while (re.exec(lines[i]) !== null) n++;
  }
  return n;
}

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Templates compiled to functions; any failure falls back to the tree walker.
  const compiled = new Map();
  let useCompiled = true;
  for (const [name, nodes] of templates) {
    const fn = compileTemplate(nodes);
    if (fn === null) {
      useCompiled = false;
      break;
    }
    compiled.set(name, fn);
  }
  if (!useCompiled) compiled.clear();

  // 1. Sources, in code-unit order of path; `.md` is a source, the rest static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the checks, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const key = `${dir}\n${target}`;
      const hit = linkCache.get(key);
      if (hit !== undefined) return hit;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let href;
      if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
      else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
      else {
        // A broken link is reported once per source that holds it, so a
        // miss is never cached: the same target from another source in
        // this directory is its own broken link.
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      linkCache.set(key, href);
      return href;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards and pages, as the templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) {
    cards.set(p, {
      title: p.data.title,
      url: p.url,
      date: p.data.date ?? '',
      date_long: p.data.date === undefined ? '' : longDate(p.data.date),
      summary: p.data.summary ?? '',
      excerpt: p.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOfLines(p.lines, p.bodyStart) / 200)),
      tags: p.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
  }
  const pageOf = (s) => {
    const card = cards.get(s) ?? {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // 7. Layouts: every page, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const pageVars = { site, tags: allTags, recent, page: null };
  const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
  const tagVars = { site, tags: allTags, recent, tag: null };
  const tagsVars = { site, tags: allTags, recent };
  const render = (name, vars) => {
    const out = [];
    if (useCompiled) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      fn([], vars, compiled, 0, out, esc, textOf, truthy, lookupDyn, incTpl);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    renderNodes(nodes, [], vars, templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, Object.assign(pageVars, { page: pageOf(s) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render(
      'index',
      Object.assign(indexVars, {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      }),
    );
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render(
      'tag',
      Object.assign(tagVars, { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } }),
    );
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsVars);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above and each broken link, sorted.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
