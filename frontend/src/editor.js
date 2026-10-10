import { EditorState, Compartment, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { bracketMatching, indentUnit, indentService, foldGutter, foldKeymap, codeFolding, foldService } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lexGocpy, lexYaml } from './lexer.js';

// ------------------------------------------------------------------ semantic highlighting

const setSpans = StateEffect.define();

const markCache = new Map();
const mark = cls => {
  let m = markCache.get(cls);
  if (!m) { m = Decoration.mark({ class: 't-' + cls }); markCache.set(cls, m); }
  return m;
};
const unsafeLine = Decoration.line({ class: 't-unsafe-line' });

// Holds the latest lexer result mapped through edits until the next re-lex.
const spansField = StateField.define({
  create: () => ({ spans: [], unsafe: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSpans)) return e.value;
    if (!tr.docChanged) return value;
    const ch = tr.changes;
    const spans = [];
    for (const s of value.spans) {
      const from = ch.mapPos(s.from, 1), to = ch.mapPos(s.to, -1);
      if (to > from) spans.push({ from, to, cls: s.cls });
    }
    const unsafe = value.unsafe.map(u => ({ from: ch.mapPos(u.from, 1), to: ch.mapPos(u.to, -1) })).filter(u => u.to > u.from);
    return { spans, unsafe };
  },
});

function highlighter(lexer) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.decorations = Decoration.none;
      this.lines = Decoration.none;
      this.relex(true);
    }
    relex(now) {
      clearTimeout(this.timer);
      const run = () => {
        const doc = this.view.state.doc;
        if (doc.length > 3_000_000) return;
        const res = lexer(doc.toString());
        this.view.dispatch({ effects: setSpans.of(res) });
      };
      if (now) queueMicrotask(run);
      else {
        const size = this.view.state.doc.length;
        this.timer = setTimeout(run, size < 60_000 ? 15 : size < 400_000 ? 120 : 400);
      }
    }
    update(u) {
      if (u.docChanged) this.relex(false);
      const changed = u.docChanged || u.viewportChanged || u.transactions.some(t => t.effects.some(e => e.is(setSpans)));
      if (changed) this.build();
    }
    build() {
      const { spans, unsafe } = this.view.state.field(spansField);
      const doc = this.view.state.doc;
      const b = new RangeSetBuilder();
      const lb = new RangeSetBuilder();
      for (const { from, to } of this.view.visibleRanges) {
        // binary search first span overlapping `from`
        let lo = 0, hi = spans.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (spans[m].to <= from) lo = m + 1; else hi = m; }
        for (let i = lo; i < spans.length && spans[i].from < to; i++) {
          const s = spans[i];
          if (s.to <= doc.length) b.add(s.from, s.to, mark(s.cls));
        }
        if (unsafe.length) {
          const seen = new Set();
          let line = doc.lineAt(from);
          while (true) {
            const inside = unsafe.some(u => u.from < line.to + 1 && u.to > line.from);
            if (inside && !seen.has(line.from)) { lb.add(line.from, line.from, unsafeLine); seen.add(line.from); }
            if (line.to >= to || line.number >= doc.lines) break;
            line = doc.line(line.number + 1);
          }
        }
      }
      this.decorations = b.finish();
      this.lines = lb.finish();
    }
    destroy() { clearTimeout(this.timer); }
  }, { decorations: v => v.decorations });
  const lines = EditorView.decorations.of(view => {
    const p = view.plugin(plugin);
    return p ? p.lines : Decoration.none;
  });
  return [spansField, plugin, lines];
}

// ------------------------------------------------------------------ language support

function braceIndent(unit) {
  return indentService.of((ctx, pos) => {
    const line = ctx.lineAt(pos, -1);
    let before;
    if (pos === line.from) {
      // re-indenting an existing line: look at the previous non-empty line
      if (line.from === 0) return 0;
      let prev = ctx.lineAt(line.from - 1, -1);
      while (prev.from > 0 && !prev.text.trim()) prev = ctx.lineAt(prev.from - 1, -1);
      before = prev.text;
    } else {
      before = line.text.slice(0, pos - line.from);
    }
    const base = /^[ \t]*/.exec(before)[0];
    let w = 0;
    for (const c of base) w = c === '\t' ? w + ctx.state.tabSize - (w % ctx.state.tabSize) : w + 1;
    const trimmed = before.replace(/\/\/.*$/, '').trimEnd();
    const after = ctx.textAfterPos(pos, 1);
    if (/[{([]$/.test(trimmed) || /^\s*(case\b.*|default\s*):$/.test(trimmed)) w += unit;
    if (/^\s*[})\]]/.test(after)) w = Math.max(0, w - unit);
    return w;
  });
}

// Auto-dedent when typing a closing brace on an otherwise empty line.
const electricBrace = EditorView.inputHandler.of((view, from, to, text) => {
  if (!/^[})\]]$/.test(text)) return false;
  const line = view.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  if (before.trim() !== '' || before === '') return false;
  const unit = view.state.facet(indentUnit);
  let ws = before;
  if (ws.endsWith(unit)) ws = ws.slice(0, -unit.length);
  else if (ws.endsWith('\t')) ws = ws.slice(0, -1);
  else ws = ws.replace(/ {1,4}$/, '');
  view.dispatch({ changes: { from: line.from, to, insert: ws + text }, selection: { anchor: line.from + ws.length + 1 }, userEvent: 'input.type' });
  return true;
});

// Fold by matching braces.
const braceFold = foldService.of((state, lineStart, lineEnd) => {
  const text = state.doc.sliceString(lineStart, lineEnd);
  const idx = text.lastIndexOf('{');
  if (idx < 0 || text.slice(idx).includes('}')) return null;
  let depth = 0;
  const from = lineStart + idx + 1;
  const iter = state.doc.iterRange(from, Math.min(state.doc.length, from + 500_000));
  let pos = from;
  for (const chunk of iter) {
    for (const c of chunk) {
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) { return pos - from > 1 && state.doc.lineAt(pos).number > state.doc.lineAt(from).number ? { from, to: pos } : null; } depth--; }
      pos++;
    }
  }
  return null;
});

export function languageFor(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'gocpy' || ext === 'go') return 'gocpy';
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  return 'text';
}

export const LANG_NAMES = { gocpy: 'Gocpy', yaml: 'YAML', text: 'Текст' };

function languageExtensions(lang) {
  if (lang === 'gocpy') return [highlighter(lexGocpy), EditorState.languageData.of(() => [{ commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', '"', "'", '`'] } }]), braceFold];
  if (lang === 'yaml') return [highlighter(lexYaml), EditorState.languageData.of(() => [{ commentTokens: { line: '#' } }])];
  return [];
}

// ------------------------------------------------------------------ editor

export class CodeEditor {
  constructor(parent, { onChange, onCursor, onSave }) {
    this.lang = new Compartment();
    this.indent = new Compartment();
    this.wrap = new Compartment();
    this.onChange = onChange;
    this.onCursor = onCursor;
    this.onSave = onSave;
    this.opts = { tabSize: 4, useTabs: true, wordWrap: false };
    this.view = new EditorView({ parent, state: this.makeState('', 'text') });
  }

  baseExtensions() {
    const o = this.opts;
    const unit = o.useTabs ? '\t' : ' '.repeat(o.tabSize);
    return [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter({ openText: '▾', closedText: '▸' }), codeFolding(),
      drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), rectangularSelection(), crosshairCursor(),
      highlightActiveLine(), highlightSelectionMatches(), bracketMatching(), closeBrackets(), electricBrace,
      this.indent.of([EditorState.tabSize.of(o.tabSize), indentUnit.of(unit), braceIndent(o.useTabs ? o.tabSize : o.tabSize)]),
      this.wrap.of(o.wordWrap ? EditorView.lineWrapping : []),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { this.onSave && this.onSave(); return true; } },
        { key: 'Mod-/', run: toggleComment },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of(u => {
        if (u.docChanged && this.onChange) this.onChange();
        if ((u.selectionSet || u.docChanged) && this.onCursor) {
          const pos = u.state.selection.main.head;
          const line = u.state.doc.lineAt(pos);
          this.onCursor(line.number, pos - line.from + 1, u.state.selection.main.to - u.state.selection.main.from);
        }
      }),
    ];
  }

  makeState(doc, lang) {
    return EditorState.create({ doc, extensions: [this.baseExtensions(), this.lang.of(languageExtensions(lang))] });
  }

  setOptions(o) {
    this.opts = { ...this.opts, ...o };
    const unit = this.opts.useTabs ? '\t' : ' '.repeat(this.opts.tabSize);
    this.view.dispatch({
      effects: [
        this.indent.reconfigure([EditorState.tabSize.of(this.opts.tabSize), indentUnit.of(unit), braceIndent(this.opts.tabSize)]),
        this.wrap.reconfigure(this.opts.wordWrap ? EditorView.lineWrapping : []),
      ],
    });
  }

  load(doc, lang) {
    this.view.setState(this.makeState(doc, lang));
    this.saved = this.view.state.doc;
  }

  markSaved() { this.saved = this.view.state.doc; }
  isDirty() { return this.saved ? !this.saved.eq(this.view.state.doc) : false; }
  text() { return this.view.state.doc.toString(); }
  focus() { this.view.focus(); }
}
