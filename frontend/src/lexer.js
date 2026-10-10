// Semantic highlighter for Gocpy (and YAML). Pure functions, no editor deps.
// lexGocpy(src) -> { spans: [{from, to, cls}], unsafe: [{from, to}] }

const KW = {
  if: 'kw-control', else: 'kw-control', for: 'kw-control', switch: 'kw-control', case: 'kw-control',
  default: 'kw-control', break: 'kw-control', continue: 'kw-control', fallthrough: 'kw-control', return: 'kw-control',
  func: 'kw-decl', type: 'kw-decl', var: 'kw-decl', const: 'kw-decl',
  struct: 'kw-typedef', interface: 'kw-typedef', map: 'kw-typedef', chan: 'kw-typedef',
  package: 'kw-module', import: 'kw-module',
  in: 'kw-in',
  go: 'kw-conc', defer: 'kw-conc', select: 'kw-conc',
  try: 'kw-exception', catch: 'kw-exception', finally: 'kw-exception', throw: 'kw-exception',
  unsafe: 'kw-unsafe',
};
const BUILTIN_TYPES = new Set(['bool', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16',
  'uint32', 'uint64', 'uintptr', 'float32', 'float64', 'string', 'byte', 'rune', 'any', 'thread']);
const ERROR_TYPES = new Set(['error', 'Exception']);
const BUILTIN_FUNCS = new Set(['len', 'cap', 'append', 'make', 'new', 'sizeof', 'close', 'delete']);
const UNSAFE_FUNCS = new Set(['malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memset', 'slice']);
const INTRINSICS = new Set(['be_to_le', 'le_to_be']);
const ANNOTATIONS = new Set(['inline', 'noinline', 'hot', 'cold', 'nogc', 'packed', 'align', 'export', 'target',
  'deprecated', 'extern']);
const STD_TYPES = new Set(['WaitGroup', 'Mutex', 'Duration']);
const ASSIGN = new Set(['=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '&^=']);
const LOGIC = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||', '!']);
const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '&^', '++', '--']);
const BRACKETS = new Set(['(', ')', '[', ']', '{', '}']);
const OPS = ['&^=', '<<=', '>>=', '...', '&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^'];
const SINGLE = '+-*/%&|^<>=!(){}[],;.:?~';
const OPERATOR_NAMES = new Set(['+', '-', '*', '/', '%', '==', '<', '<<', '>>', '&', '|', '^', '!', '[']);
const TODO_RE = /\b(TODO|FIXME|XXX|HACK|NOTE)\b/g;

const isIdStart = c => { const x = c.charCodeAt(0); if (x < 128) return (x >= 97 && x <= 122) || (x >= 65 && x <= 90) || x === 95; return /[\p{L}]/u.test(c); };
const isIdPart = c => { const x = c.charCodeAt(0); if (x < 128) return (x >= 97 && x <= 122) || (x >= 65 && x <= 90) || x === 95 || (x >= 48 && x <= 57); return /[\p{L}\p{N}]/u.test(c); };
const isDigit = c => c >= '0' && c <= '9';

// ------------------------------------------------------------------ raw lexer

function escapeLen(s, i) {
  const c = s[i + 1];
  if (c === 'x') return 4;
  if (c === 'u') return 6;
  if (c === 'U') return 10;
  if (c >= '0' && c <= '7') return 4;
  return 2;
}

// Scans [i, end) and appends raw tokens to out. Token: {t, from, to, v, line, first, ws}
function rawLex(s, i, end, out, st) {
  while (i < end) {
    const c = s[i];
    if (c === '\n') { st.line++; st.lineHasTok = false; st.ws = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { st.ws = true; i++; continue; }
    const from = i;
    const push = (t, to, extra) => {
      const tok = { t, from, to, line: st.line, first: !st.lineHasTok, ws: st.ws, ...extra };
      out.push(tok);
      st.lineHasTok = true;
      st.ws = false;
      return tok;
    };
    if (c === '/' && s[i + 1] === '/') {
      let j = s.indexOf('\n', i); if (j < 0 || j > end) j = end;
      out.push({ t: 'cmt', from, to: j, line: st.line }); st.ws = true; i = j; continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      let j = s.indexOf('*/', i + 2); j = j < 0 || j + 2 > end ? end : j + 2;
      for (let k = i; k < j; k++) if (s[k] === '\n') { st.line++; st.lineHasTok = false; }
      out.push({ t: 'cmt', from, to: j, line: st.line }); st.ws = true; i = j; continue;
    }
    if (c === 'f' && s[i + 1] === '"') { i = lexFString(s, i, end, push, st); continue; }
    if (isIdStart(c)) {
      let j = i + 1; while (j < end && isIdPart(s[j])) j++;
      push('id', j, { v: s.slice(i, j) }); i = j; continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] || ''))) {
      let j = i, kind = 'num-int';
      if (c === '0' && /[xXbBoO]/.test(s[i + 1] || '')) {
        kind = 'num-radix'; j = i + 2;
        while (j < end && /[0-9a-fA-F_]/.test(s[j])) j++;
      } else {
        while (j < end && (isDigit(s[j]) || s[j] === '_')) j++;
        if (s[j] === '.' && s[j + 1] !== '.') { kind = 'num-float'; j++; while (j < end && (isDigit(s[j]) || s[j] === '_')) j++; }
        if (s[j] === 'e' || s[j] === 'E') {
          let k = j + 1; if (s[k] === '+' || s[k] === '-') k++;
          if (isDigit(s[k] || '')) { kind = 'num-float'; j = k; while (j < end && isDigit(s[j])) j++; }
        }
      }
      let bad = false; while (j < end && isIdPart(s[j])) { j++; bad = true; }
      push('num', j, { kind: bad ? 'invalid' : kind }); i = j; continue;
    }
    if (c === '"' || c === '\'') {
      const esc = []; let j = i + 1, closed = false;
      while (j < end && s[j] !== '\n') {
        if (s[j] === '\\') { const n = escapeLen(s, j); esc.push([j, Math.min(j + n, end)]); j += n; continue; }
        if (s[j] === c) { j++; closed = true; break; }
        j++;
      }
      push(c === '"' ? 'str' : 'char', Math.min(j, end), { esc, closed }); i = Math.min(j, end); continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1); j = j < 0 || j >= end ? end : j + 1;
      const tok = push('raw', j);
      for (let k = i; k < j; k++) if (s[k] === '\n') { st.line++; }
      if (j > i && s.slice(i, j).includes('\n')) st.lineHasTok = true;
      i = j; void tok; continue;
    }
    if (c === '@' && isIdStart(s[i + 1] || '')) {
      let j = i + 2; while (j < end && isIdPart(s[j])) j++;
      push('annot', j, { v: s.slice(i + 1, j) }); i = j; continue;
    }
    let op = null;
    for (const o of OPS) if (s.startsWith(o, i) && i + o.length <= end) { op = o; break; }
    if (!op && SINGLE.includes(c)) op = c;
    if (op) { push('op', i + op.length, { v: op }); i += op.length; continue; }
    // any other character (e.g. $, #, emoji)
    const cp = s.codePointAt(i); const w = cp > 0xffff ? 2 : 1;
    push('bad', i + w); i += w;
  }
}

// f"text {expr} {expr:spec} {{literal}}"
function lexFString(s, i, end, push, st) {
  const parts = []; // [from, to, cls]
  const inner = []; // raw token lists of embedded expressions
  let j = i + 2, text = i;
  const flushText = k => { if (k > text) parts.push([text, k, 'str-f']); };
  while (j < end) {
    const c = s[j];
    if (c === '\n') break;
    if (c === '"') { j++; break; }
    if (c === '\\') { flushText(j); const n = escapeLen(s, j); parts.push([j, Math.min(j + n, end), 'str-escape']); j += n; text = j; continue; }
    if ((c === '{' && s[j + 1] === '{') || (c === '}' && s[j + 1] === '}')) { flushText(j); parts.push([j, j + 2, 'str-escape']); j += 2; text = j; continue; }
    if (c === '{') {
      flushText(j);
      parts.push([j, j + 1, 'str-interp']);
      let k = j + 1, depth = 0, specAt = -1;
      while (k < end && s[k] !== '\n') {
        const d = s[k];
        if (d === '"' || d === '\'') { const q = d; k++; while (k < end && s[k] !== q && s[k] !== '\n') { if (s[k] === '\\') k++; k++; } k++; continue; }
        if (d === '(' || d === '[' || d === '{') depth++;
        else if (d === ')' || d === ']') depth--;
        else if (d === '}') { if (depth === 0) break; depth--; }
        else if (d === ':' && depth === 0 && s[k + 1] !== '=') { specAt = k; break; }
        k++;
      }
      const exprEnd = Math.min(k, end);
      const toks = [];
      rawLex(s, j + 1, exprEnd, toks, { line: st.line, lineHasTok: true, ws: false });
      inner.push(toks);
      k = exprEnd;
      if (specAt >= 0) {
        let e = specAt; while (e < end && s[e] !== '}' && s[e] !== '\n' && s[e] !== '"') e++;
        parts.push([specAt, e, 'str-fspec']); k = e;
      }
      if (s[k] === '}') { parts.push([k, k + 1, 'str-interp']); k++; }
      j = k; text = j; continue;
    }
    j++;
  }
  flushText(j);
  // the "f" prefix and opening quote are part of the first text run (text starts at i)
  push('fstr', j, { parts, inner });
  return j;
}

// ------------------------------------------------------------------ semantic pass

function matchBrackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'op') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{') stack.push(k);
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      const open = { ')': '(', ']': '[', '}': '{' }[t.v];
      // pop until the matching opener (tolerates broken code)
      for (let s = stack.length - 1; s >= 0; s--) {
        if (toks[stack[s]].v === open) { match[stack[s]] = k; match[k] = stack[s]; stack.length = s; break; }
      }
    }
  }
  return match;
}

const isOp = (t, v) => t && t.t === 'op' && t.v === v;
const isId = t => t && t.t === 'id' && !(t.v in KW);
const isKw = (t, v) => t && t.t === 'id' && t.v === v;

function analyze(toks, src) {
  const n = toks.length;
  const match = matchBrackets(toks);
  const ctx = {
    pkgNames: new Set(), userTypes: new Set(), consts: new Set(), funcNames: new Set(),
    decl: new Map(), // token index -> class
    scopes: [], // {from, to, names:Set} for type params
    unsafe: [], // {from, to}
  };
  // brace depth per token
  const depth = new Int32Array(n);
  let d = 0;
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (isOp(t, '}')) d = Math.max(0, d - 1);
    depth[k] = d;
    if (isOp(t, '{')) d++;
  }

  const groupItems = (open, fn) => { // calls fn(index) for tokens inside (...) group at depth 1
    const close = match[open];
    if (close < 0) return n;
    for (let k = open + 1; k < close; k++) fn(k);
    return close;
  };

  const typeParamList = (open) => { // [T, U any] -> Set of names
    const names = new Set();
    const close = match[open];
    if (close < 0) return names;
    let start = true, dep = 0;
    for (let k = open + 1; k < close; k++) {
      const t = toks[k];
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) dep++;
      if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) dep--;
      if (dep === 0 && isOp(t, ',')) { start = true; continue; }
      if (start && isId(t)) { names.add(t.v); ctx.decl.set(k, 'type-param'); }
      start = false;
    }
    return names;
  };
  const looksGeneric = (open) => {
    const a = toks[open + 1], b = toks[open + 2];
    if (!isId(a) || !b) return false;
    if (isOp(b, ']')) return false;
    return b.t === 'id' || isOp(b, ',') || isOp(b, '~') || isOp(b, '[') || isOp(b, '*');
  };
  const starts = [];
  for (let j = 0; j < n; j++) {
    const t = toks[j];
    if (depth[j] === 0 && t.first && ((t.t === 'id' && (t.v === 'func' || t.v === 'type' || t.v === 'var' || t.v === 'const' || t.v === 'import')) || t.t === 'annot')) starts.push(j);
  }
  const declEnd = (k) => { // start of the next top-level declaration
    let lo = 0, hi = starts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= k) lo = m + 1; else hi = m; }
    return lo < starts.length ? toks[starts[lo]].from : Infinity;
  };

  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t !== 'id') continue;
    const next = toks[k + 1];
    switch (t.v) {
      case 'package':
        if (isId(next)) ctx.decl.set(k + 1, 'pkg-decl');
        break;
      case 'import': {
        const spec = (j) => {
          let a = toks[j];
          let alias = null, ai = -1;
          if (isId(a) || isOp(a, '.')) { alias = a.v; ai = j; a = toks[j + 1]; j++; }
          if (a && a.t === 'str') {
            const path = src.slice(a.from + 1, a.to - 1);
            const name = alias && alias !== '.' ? alias : path.split('/').pop();
            if (alias !== '.' && name) ctx.pkgNames.add(name);
            ctx.decl.set(j, 'pkg-path');
            if (ai >= 0 && alias !== '.') ctx.decl.set(ai, 'pkg-name');
          }
        };
        if (isOp(next, '(')) {
          const close = match[k + 1] < 0 ? n : match[k + 1];
          for (let j = k + 2; j < close; j++) if (toks[j].first || toks[j - 1].v === '(' || isOp(toks[j - 1], ';')) spec(j);
        } else spec(k + 1);
        break;
      }
      case 'type': {
        const one = (j) => {
          if (!isId(toks[j])) return;
          ctx.userTypes.add(toks[j].v);
          ctx.decl.set(j, 'type-user');
          if (isOp(toks[j + 1], '[') && looksGeneric(j + 1)) {
            const names = typeParamList(j + 1);
            ctx.scopes.push({ from: toks[j].from, to: declEnd(k), names });
          }
        };
        if (isOp(next, '(')) groupItems(k + 1, j => { if (toks[j].first && depth[j] === depth[k]) one(j); });
        else one(k + 1);
        break;
      }
      case 'const': {
        const list = (j) => {
          while (isId(toks[j])) {
            ctx.consts.add(toks[j].v); ctx.decl.set(j, 'const-user');
            if (isOp(toks[j + 1], ',')) j += 2; else break;
          }
        };
        if (isOp(next, '(')) groupItems(k + 1, j => { if (toks[j].first && isId(toks[j])) list(j); });
        else list(k + 1);
        break;
      }
      case 'struct': {
        if (!isOp(next, '{')) break;
        const close = match[k + 1] < 0 ? n : match[k + 1];
        let dep = 0;
        for (let j = k + 2; j < close; j++) {
          const f = toks[j];
          if (f.t === 'op' && (f.v === '{' || f.v === '(' || f.v === '[')) dep++;
          if (f.t === 'op' && (f.v === '}' || f.v === ')' || f.v === ']')) dep--;
          if (dep !== 0 || !isId(f)) continue;
          const prev = toks[j - 1];
          const startOfField = f.first || isOp(prev, '{') || isOp(prev, ';');
          if (!startOfField) continue;
          const nx = toks[j + 1];
          if (!nx || nx.line !== f.line || isOp(nx, '.') || nx.t === 'str') continue; // embedded type
          let m = j;
          while (isId(toks[m])) { ctx.decl.set(m, 'field-decl'); if (isOp(toks[m + 1], ',')) m += 2; else break; }
        }
        break;
      }
      case 'interface': {
        if (!isOp(next, '{')) break;
        const close = match[k + 1] < 0 ? n : match[k + 1];
        for (let j = k + 2; j < close; j++) {
          const f = toks[j];
          if (isId(f) && (f.first || isOp(toks[j - 1], '{') || isOp(toks[j - 1], ';')) && isOp(toks[j + 1], '(')) ctx.decl.set(j, 'func-decl');
        }
        break;
      }
      case 'unsafe': {
        if (isOp(next, '{')) {
          const close = match[k + 1];
          ctx.unsafe.push({ from: t.from, to: close >= 0 ? toks[close].to : src.length });
        }
        break;
      }
      case 'func': {
        let j = k + 1;
        let scopeNames = null;
        if (isOp(toks[j], '(')) {
          // receiver (method decl) or function literal / type
          const close = match[j];
          if (close < 0) break;
          const after = toks[close + 1];
          const isMethod = after && (isId(after) || (after.t === 'op' && OPERATOR_NAMES.has(after.v)));
          if (!isMethod || depth[k] !== 0 || !t.first) break;
          // generic receiver: (s *Stack[T])
          for (let r = j + 1; r < close; r++) {
            if (isOp(toks[r], '[') && isId(toks[r - 1])) { scopeNames = typeParamList(r); break; }
          }
          j = close + 1;
          const nm = toks[j];
          if (isId(nm)) { ctx.decl.set(j, 'func-decl'); }
          else if (nm && nm.t === 'op') {
            ctx.decl.set(j, 'func-operator');
            if (nm.v === '[' && isOp(toks[j + 1], ']')) { ctx.decl.set(j + 1, 'func-operator'); j++; }
          }
        } else if (isId(toks[j]) && (t.first || depth[k] === 0)) {
          ctx.decl.set(j, 'func-decl');
          ctx.funcNames.add(toks[j].v);
          if (isOp(toks[j + 1], '[') && looksGeneric(j + 1)) scopeNames = typeParamList(j + 1);
        }
        if (scopeNames && scopeNames.size) ctx.scopes.push({ from: t.from, to: declEnd(k), names: scopeNames });
        break;
      }
      case 'break': case 'continue': {
        if (isId(next) && next.line === t.line) ctx.decl.set(k + 1, 'label');
        break;
      }
      default:
        if (t.first && isOp(next, ':') && toks[k + 2] && ['for', 'switch', 'select'].includes(toks[k + 2].v)) ctx.decl.set(k, 'label');
    }
  }
  ctx.match = match;
  return ctx;
}

// merged, sorted, disjoint ranges -> binary search
function mergeRanges(ranges) {
  const r = ranges.map(x => ({ from: x.from, to: x.to })).sort((a, b) => a.from - b.from);
  const out = [];
  for (const x of r) {
    if (out.length && x.from <= out[out.length - 1].to) out[out.length - 1].to = Math.max(out[out.length - 1].to, x.to);
    else out.push(x);
  }
  return out;
}
function inRanges(ranges, pos) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, r = ranges[m];
    if (pos < r.from) hi = m - 1; else if (pos >= r.to) lo = m + 1; else return true;
  }
  return false;
}

function typeParamAt(ctx, name, pos) {
  if (!ctx.scopeIdx) {
    ctx.scopeIdx = new Map();
    for (const s of ctx.scopes) for (const nm of s.names) {
      if (!ctx.scopeIdx.has(nm)) ctx.scopeIdx.set(nm, []);
      ctx.scopeIdx.get(nm).push(s);
    }
    for (const [k, v] of ctx.scopeIdx) ctx.scopeIdx.set(k, mergeRanges(v));
  }
  const list = ctx.scopeIdx.get(name);
  return !!list && inRanges(list, pos);
}

function classifyIdent(toks, k, ctx, inUnsafe) {
  const t = toks[k], p = toks[k - 1], nx = toks[k + 1];
  const v = t.v;
  if (v in KW) return KW[v];
  if (ctx.decl.has(k)) return ctx.decl.get(k);
  if (v === 'true' || v === 'false') return 'const-bool';
  if (v === 'nil') return 'const-nil';
  const call = isOp(nx, '(');
  if (isOp(p, '.')) {
    const pp = toks[k - 2];
    if (isId(pp) && ctx.pkgNames.has(pp.v) && !isOp(toks[k - 3], '.')) {
      if (call) return 'func-std';
      if (STD_TYPES.has(v)) return 'type-std';
      if (ctx.userTypes.has(v)) return 'type-user';
      return 'pkg-member';
    }
    return call ? 'func-method' : 'field';
  }
  if (isOp(nx, '.') && ctx.pkgNames.has(v)) return 'pkg-name';
  if (inUnsafe && call && UNSAFE_FUNCS.has(v)) return 'unsafe-func';
  if (typeParamAt(ctx, v, t.from)) return 'type-param';
  if (BUILTIN_TYPES.has(v)) return inUnsafe && call && v === 'uintptr' ? 'unsafe-cast' : 'type-builtin';
  if (ERROR_TYPES.has(v)) return 'type-error';
  if (v === 'comparable') return 'type-constraint';
  if (ctx.userTypes.has(v)) return 'type-user';
  if (call && BUILTIN_FUNCS.has(v)) return 'func-builtin';
  if (ctx.consts.has(v)) return 'const-user';
  if (call) return 'func-call';
  if (isOp(nx, '[') && ctx.funcNames.has(v)) return 'func-call';
  return 'var';
}

function isUnary(toks, k, src) {
  const t = toks[k], p = toks[k - 1];
  if (!p) return true;
  if (p.t === 'op' && !(p.v === ')' || p.v === ']' || p.v === '}')) return true;
  if (p.t === 'id' && p.v in KW && p.v !== 'true') return true;
  if (p.t === 'annot') return true;
  const after = src[t.to];
  if (t.ws && after && after !== ' ' && after !== '\t' && after !== '\n') return true;
  return false;
}

function pushSplit(spans, from, to, cls, esc) {
  let pos = from;
  for (const [a, b] of esc || []) {
    if (a > pos) spans.push({ from: pos, to: a, cls });
    spans.push({ from: a, to: b, cls: 'str-escape' });
    pos = b;
  }
  if (to > pos) spans.push({ from: pos, to, cls });
}

function emitComment(spans, src, t) {
  const text = src.slice(t.from, t.to);
  if (text.startsWith('//gocpy:')) { spans.push({ from: t.from, to: t.to, cls: 'comment-directive' }); return; }
  let pos = 0; TODO_RE.lastIndex = 0; let m;
  while ((m = TODO_RE.exec(text))) {
    if (m.index > pos) spans.push({ from: t.from + pos, to: t.from + m.index, cls: 'comment' });
    spans.push({ from: t.from + m.index, to: t.from + m.index + m[0].length, cls: 'comment-todo' });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) spans.push({ from: t.from + pos, to: t.to, cls: 'comment' });
}

function classifyList(all, src, ctx, spans, isMain) {
  const toks = all.filter(t => t.t !== 'cmt');
  if (isMain) { Object.assign(ctx, analyze(toks, src)); ctx.unsafeMerged = mergeRanges(ctx.unsafe); }
  const match = isMain ? ctx.match : matchBrackets(toks);
  for (const t of all) if (t.t === 'cmt') emitComment(spans, src, t);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const inU = ctx.unsafeMerged.length > 0 && inRanges(ctx.unsafeMerged, t.from);
    switch (t.t) {
      case 'id': {
        spans.push({ from: t.from, to: t.to, cls: classifyIdent(toks, k, isMain ? ctx : ctx.innerCtx || (ctx.innerCtx = { ...ctx, decl: new Map() }), inU) });
        break;
      }
      case 'num': spans.push({ from: t.from, to: t.to, cls: t.kind }); break;
      case 'str': {
        if (isMain && ctx.decl.get(k) === 'pkg-path') spans.push({ from: t.from, to: t.to, cls: 'pkg-path' });
        else pushSplit(spans, t.from, t.to, 'str', t.esc);
        break;
      }
      case 'char': pushSplit(spans, t.from, t.to, 'char', t.esc); break;
      case 'raw': spans.push({ from: t.from, to: t.to, cls: 'str-raw' }); break;
      case 'fstr': {
        for (const [a, b, c] of t.parts) spans.push({ from: a, to: b, cls: c });
        for (const inner of t.inner) classifyList(inner, src, ctx, spans, false);
        break;
      }
      case 'annot': {
        const v = t.v;
        const cls = INTRINSICS.has(v) ? 'intrinsic' : v === 'throws' ? 'annot-throws' : v === 'overload' ? 'annot-overload'
          : ANNOTATIONS.has(v) ? 'annot' : 'annot-unknown';
        spans.push({ from: t.from, to: t.to, cls });
        break;
      }
      case 'op': {
        const v = t.v;
        let cls;
        if (isMain && ctx.decl.has(k)) cls = ctx.decl.get(k);
        else if (v === '?') cls = 'op-question';
        else if (v === '<-') cls = 'op-arrow';
        else if (v === '~') cls = 'type-constraint';
        else if (ASSIGN.has(v)) cls = 'op-assign';
        else if (v === '*' || v === '&') {
          cls = isUnary(toks, k, src) ? 'op-ptr' : 'op-arith';
          // unsafe pointer cast: (*T)(x) or (*pkg.T)(x)
          if (inU && v === '*' && isOp(toks[k - 1], '(')) {
            const close = match[k - 1];
            if (close > k && isOp(toks[close + 1], '(')) {
              cls = 'unsafe-cast';
              for (let j = k + 1; j < close; j++) if (toks[j].t === 'id') spans.push({ from: toks[j].from, to: toks[j].to, cls: 'unsafe-cast', force: true });
            }
          }
        }
        else if (LOGIC.has(v)) cls = 'op-logic';
        else if (ARITH.has(v)) cls = 'op-arith';
        else if (BRACKETS.has(v)) cls = 'punct-bracket';
        else cls = 'punct';
        spans.push({ from: t.from, to: t.to, cls });
        break;
      }
      case 'bad': spans.push({ from: t.from, to: t.to, cls: 'invalid' }); break;
    }
  }
}

export function lexGocpy(src) {
  const raw = [];
  rawLex(src, 0, src.length, raw, { line: 0, lineHasTok: false, ws: true });
  const ctx = { unsafe: [] };
  const spans = [];
  classifyList(raw, src, ctx, spans, true);
  // forced spans (unsafe casts) override the ident class at the same position
  spans.sort((a, b) => a.from - b.from || (b.force ? 1 : 0) - (a.force ? 1 : 0) || a.to - b.to);
  const out = [];
  let last = -1;
  for (const s of spans) {
    if (s.from < last || s.to <= s.from) continue; // drop overlaps
    out.push({ from: s.from, to: s.to, cls: s.cls });
    last = s.to;
  }
  return { spans: out, unsafe: ctx.unsafe };
}

// ------------------------------------------------------------------ YAML

export function lexYaml(src) {
  const spans = [];
  let pos = 0;
  for (const line of src.split('\n')) {
    const base = pos;
    pos += line.length + 1;
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (line[i] === '#') { spans.push({ from: base + i, to: base + line.length, cls: 'yaml-comment' }); continue; }
    while (line[i] === '-' && (line[i + 1] === ' ' || i + 1 === line.length)) { spans.push({ from: base + i, to: base + i + 1, cls: 'yaml-punct' }); i += 1; while (line[i] === ' ') i++; }
    // key:
    const km = /^("[^"]*"|'[^']*'|[^\s:#][^:#]*?)\s*:(?=\s|$)/.exec(line.slice(i));
    if (km) {
      const keyLen = km[1].length;
      spans.push({ from: base + i, to: base + i + keyLen, cls: 'yaml-key' });
      const colon = i + km[0].length - 1;
      spans.push({ from: base + colon, to: base + colon + 1, cls: 'yaml-punct' });
      i = colon + 1;
    }
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) continue;
    // value (+ trailing comment)
    let end = line.length;
    let inQ = null;
    for (let j = i; j < line.length; j++) {
      const c = line[j];
      if (inQ) { if (c === inQ) inQ = null; continue; }
      if (c === '"' || c === '\'') inQ = c;
      else if (c === '#' && (j === 0 || line[j - 1] === ' ')) { end = j; break; }
    }
    const val = line.slice(i, end).trimEnd();
    const vEnd = i + val.length;
    if (/^[\[\]{},]/.test(val) || val.startsWith('[')) {
      // flow sequence: highlight punctuation and items
      const re = /([\[\]{},])|("[^"]*"|'[^']*')|([^\s\[\]{},]+)/g; let m;
      while ((m = re.exec(val))) {
        const a = base + i + m.index, b = a + m[0].length;
        spans.push({ from: a, to: b, cls: m[1] ? 'yaml-punct' : scalarClass(m[0]) });
      }
    } else if (val) {
      spans.push({ from: base + i, to: base + vEnd, cls: scalarClass(val) });
    }
    if (end < line.length) spans.push({ from: base + end, to: base + line.length, cls: 'yaml-comment' });
  }
  return { spans, unsafe: [] };
}

function scalarClass(v) {
  if (/^(true|false|yes|no|on|off|null|~)$/i.test(v)) return 'yaml-bool';
  if (/^[-+]?(\d[\d_]*(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-fA-F]+)$/.test(v)) return 'yaml-number';
  return 'yaml-string';
}
