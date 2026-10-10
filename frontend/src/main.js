import '@xterm/xterm/css/xterm.css';
import './app.css';
import { undo, redo, toggleComment } from '@codemirror/commands';
import { openSearchPanel, gotoLine } from '@codemirror/search';
import { CodeEditor, languageFor, LANG_NAMES } from './editor.js';
import { TermView } from './terminal.js';
import { CATEGORIES, GROUPS, DEFAULT_COLORS, effectiveColors, applyColors, categoryCSS } from './categories.js';

// ------------------------------------------------------------------ token & api

const params = new URLSearchParams(location.search);
if (params.get('token')) {
  sessionStorage.setItem('gocpy-token', params.get('token'));
  history.replaceState(null, '', location.pathname);
}
const TOKEN = sessionStorage.getItem('gocpy-token') || '';

async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'X-Token': TOKEN } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}

const $ = sel => document.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

function toast(msg, kind = '') {
  const el = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

// ------------------------------------------------------------------ modal

function modal({ title, body, buttons = [], wide = false, onOpen, cls = '' }) {
  return new Promise(resolve => {
    const ov = $('#overlay');
    const close = v => { ov.classList.remove('on'); ov.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const foot = buttons.length ? h('div', { class: 'modal-foot' }, buttons.map(b =>
      h('button', { class: 'btn ' + (b.cls || ''), onclick: () => { if (b.onClick && b.onClick() === false) return; close(b.value); } }, b.label))) : null;
    const box = h('div', { class: 'modal ' + (wide ? 'wide ' : '') + cls },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'x', title: 'Закрыть', onclick: () => close(undefined) }, '×')),
      body, foot);
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); }
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT' && e.target.type !== 'color') {
        const def = buttons.find(b => b.default);
        if (def) { e.preventDefault(); if (def.onClick && def.onClick() === false) return; close(def.value); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    ov.innerHTML = '';
    ov.append(box);
    ov.classList.add('on');
    ov.onmousedown = e => { if (e.target === ov) close(undefined); };
    if (onOpen) onOpen(box, close);
  });
}

function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return modal({
    title, body: h('div', { class: 'modal-body' }, h('p', {}, text)),
    buttons: [{ label: 'Отмена', value: false }, { label: okLabel, cls: danger ? 'danger' : 'primary', value: true, default: true }],
    onOpen: box => box.querySelector('.modal-foot .btn:last-child').focus(),
  }).then(v => !!v);
}

// ------------------------------------------------------------------ state

const S = {
  project: '', projectName: '', recent: [], settings: null, os: 'darwin', home: '',
  tree: null, expanded: new Set(), selected: '', file: '', fileMtime: 0, running: false,
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem('gocpy-ide:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem('gocpy-ide:' + k, JSON.stringify(v)); },
};

// ------------------------------------------------------------------ colors

const styleEl = document.createElement('style');
styleEl.textContent = categoryCSS();
document.head.append(styleEl);

function applySettingsToUI() {
  const s = S.settings;
  applyColors(effectiveColors(s.colors));
  document.documentElement.style.setProperty('--editor-size', (s.fontSize || 13) + 'px');
  document.documentElement.style.setProperty('--editor-font', s.fontFamily || 'SF Mono, Menlo, monospace');
  editor.setOptions({ tabSize: s.tabSize || 4, useTabs: s.useTabs !== false, wordWrap: !!s.wordWrap });
  editor.view.requestMeasure();
  for (const t of [shellTerm, runTerm]) t && t.setFont(s.termFontSize || 12, s.fontFamily);
  $('#sb-indent').textContent = (s.useTabs !== false ? 'Табы: ' : 'Пробелы: ') + (s.tabSize || 4);
}

// ------------------------------------------------------------------ editor

const editor = new CodeEditor($('#editor'), {
  onChange: () => updateDirty(),
  onCursor: (line, col, sel) => { $('#sb-cursor').textContent = `Стр ${line}, стлб ${col}` + (sel ? ` (выделено ${sel})` : ''); },
  onSave: () => saveFile(),
});

function updateDirty() {
  const dirty = !!S.file && editor.isDirty();
  $('#dirty-indicator').classList.toggle('on', dirty);
  document.title = (dirty ? '● ' : '') + (S.file ? S.file.split('/').pop() + ' — ' : '') + (S.projectName || 'Gocpy IDE');
  const node = document.querySelector(`.node[data-path="${CSS.escape(S.file)}"]`);
  document.querySelectorAll('.node.dirty').forEach(n => n !== node && n.classList.remove('dirty'));
  if (node) node.classList.toggle('dirty', dirty);
}

function renderBreadcrumbs() {
  const bc = $('#breadcrumbs');
  bc.innerHTML = '';
  if (!S.file) { bc.append(h('span', {}, S.project ? 'Файл не открыт' : '')); return; }
  const parts = [S.projectName, ...S.file.split('/')];
  parts.forEach((p, i) => {
    if (i) bc.append(h('span', { class: 'sep' }, '›'));
    bc.append(h('span', { class: i === parts.length - 1 ? 'cur' : '' }, p));
  });
}

async function maybeSaveBeforeLeave() {
  if (!S.file || !editor.isDirty()) return true;
  const v = await modal({
    title: 'Несохранённые изменения',
    body: h('div', { class: 'modal-body' }, h('p', {}, `Сохранить изменения в «${S.file}»?`)),
    buttons: [{ label: 'Отмена', value: 'cancel', cls: 'ghost' }, { label: 'Не сохранять', value: 'discard' }, { label: 'Сохранить', value: 'save', cls: 'primary', default: true }],
    onOpen: box => box.querySelector('.btn.primary').focus(),
  });
  if (v === 'save') return await saveFile();
  return v === 'discard';
}

async function openFile(path, { force = false } = {}) {
  if (!force && path === S.file) { editor.focus(); return; }
  if (!force && !(await maybeSaveBeforeLeave())) return;
  let res;
  try { res = await api('/api/file?path=' + encodeURIComponent(path)); } catch (e) { toast(e.message, 'error'); return; }
  S.file = path;
  S.selected = path;
  if (res.binary) {
    editor.load(`// Бинарный файл (${res.size} байт) — просмотр недоступен`, 'text');
    editor.view.contentDOM.setAttribute('contenteditable', 'false');
    S.file = '';
  } else {
    editor.load(res.content, languageFor(path));
    S.fileMtime = res.mtime;
  }
  applySettingsToUI();
  $('#sb-lang').textContent = LANG_NAMES[languageFor(path)];
  showWelcome(false);
  renderBreadcrumbs();
  updateDirty();
  revealInTree(path);
  api('/api/lastfile', { path: S.file }).catch(() => {});
  editor.focus();
}

function closeEditor() {
  S.file = '';
  $('#sb-lang').textContent = '';
  $('#sb-cursor').textContent = '';
  editor.load('', 'text');
  renderBreadcrumbs();
  updateDirty();
  showWelcome(true);
}

async function saveFile() {
  if (!S.file) return true;
  const content = editor.text();
  try {
    const r = await api('/api/file', { path: S.file, content }, 'PUT');
    S.fileMtime = r.mtime;
    editor.markSaved();
    updateDirty();
    return true;
  } catch (e) { toast('Не удалось сохранить: ' + e.message, 'error'); return false; }
}

// ------------------------------------------------------------------ welcome

function showWelcome(on) {
  const w = $('#welcome');
  w.classList.toggle('on', on);
  if (!on) return;
  w.innerHTML = '';
  const inner = h('div', { class: 'welcome-inner' },
    h('h1', {}, 'Gocpy IDE'),
    h('p', { class: 'tag' }, S.project ? `Проект «${S.projectName}» открыт. Выберите файл слева или создайте новый.` : 'Лёгкая среда разработки для языка gocpy'),
    h('h2', {}, 'Начать'),
    h('div', { class: 'welcome-actions' },
      S.project ? h('button', { class: 'link', onclick: () => cmd.newFile() }, '＋ Новый файл…') : null,
      h('button', { class: 'link', onclick: () => cmd.newProject() }, '＋ Новый проект…'),
      h('button', { class: 'link', onclick: () => cmd.openProject() }, '📂 Открыть проект…'.replace('📂 ', '↗ ')),
    ),
  );
  const rec = S.recent.filter(p => p !== S.project).slice(0, 8);
  if (rec.length) {
    inner.append(h('h2', {}, 'Недавние'));
    for (const p of rec) inner.append(h('div', { class: 'recent-item' },
      h('button', { class: 'link', onclick: () => openProject(p) }, p.split('/').pop()), h('span', { class: 'path' }, tildify(p))));
  }
  inner.append(h('h2', {}, 'Горячие клавиши'), h('div', { class: 'welcome-keys' },
    h('kbd', {}, '⌘R / F5'), h('span', {}, 'Запустить программу'),
    h('kbd', {}, '⇧F5'), h('span', {}, 'Остановить'),
    h('kbd', {}, '⌘S'), h('span', {}, 'Сохранить файл'),
    h('kbd', {}, '⌘O'), h('span', {}, 'Открыть проект'),
    h('kbd', {}, '⌥⌘N'), h('span', {}, 'Новый файл'),
    h('kbd', {}, '⌘,'), h('span', {}, 'Настройки'),
    h('kbd', {}, '⌘F'), h('span', {}, 'Поиск и замена'),
    h('kbd', {}, '⌘/'), h('span', {}, 'Закомментировать строку'),
  ));
  w.append(inner);
}

const tildify = p => (S.home && p.startsWith(S.home) ? '~' + p.slice(S.home.length) : p);

// ------------------------------------------------------------------ tree

const ICON = {
  chev: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8h-13z" fill="#c09553" opacity=".9"/></svg>',
  folderOpen: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1.5 3.5h4.3l1.5 1.5h6.2v2H4.2L1.5 13z" fill="#c09553" opacity=".75"/><path d="M4.2 7h11l-2.6 6H1.5z" fill="#dcb67a"/></svg>',
  gocpy: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="#00add8"/><path d="M5 6.2 3.6 8 5 9.8M11 6.2 12.4 8 11 9.8M8.9 5.5 7.1 10.5" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  yaml: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 4h2l1.5 2.5L8 4h2L7.4 8v4H5.6V8z" fill="#cb4b74"/><path d="M10 9h4M10 11.5h3" stroke="#cb4b74" stroke-width="1.4"/></svg>',
  md: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="#519aba"/><path d="M4 10V6l1.5 2L7 6v4M10.5 6v4M9 8.5l1.5 1.5L12 8.5" fill="none" stroke="#519aba" stroke-width="1.1"/></svg>',
  c: '<svg viewBox="0 0 16 16" width="16" height="16"><text x="8" y="12" font-size="11" font-weight="700" text-anchor="middle" fill="#a074c4" font-family="sans-serif">C</text></svg>',
  git: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.8 14.2 8 8 14.2 1.8 8z" fill="#e06c44"/><circle cx="8" cy="8" r="1.4" fill="#fff"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="#9d9d9d"/><path d="M9.5 1.5v3h3" fill="none" stroke="#9d9d9d"/></svg>',
};
function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'gocpy' || ext === 'go') return ICON.gocpy;
  if (ext === 'yml' || ext === 'yaml') return ICON.yaml;
  if (ext === 'md') return ICON.md;
  if (ext === 'c' || ext === 'h') return ICON.c;
  if (name.startsWith('.git')) return ICON.git;
  return ICON.file;
}

async function loadTree() {
  if (!S.project) { S.tree = null; renderTree(); return; }
  try { S.tree = await api('/api/tree'); } catch (e) { toast(e.message, 'error'); S.tree = null; }
  renderTree();
}

function findNode(path, nodes = S.tree && S.tree.children) {
  for (const n of nodes || []) {
    if (n.path === path) return n;
    if (n.dir && path.startsWith(n.path + '/')) { const r = findNode(path, n.children); if (r) return r; }
  }
  return null;
}

function renderTree() {
  const el = $('#tree');
  el.innerHTML = '';
  if (!S.project) {
    el.append(h('div', { class: 'tree-empty' }, 'Проект не открыт.', h('br'),
      h('button', { onclick: () => cmd.openProject() }, 'Открыть проект'), ' или ', h('button', { onclick: () => cmd.newProject() }, 'создать новый'), '.'));
    return;
  }
  if (!S.tree) return;
  const rootOpen = !S.expanded.has('!root-collapsed');
  const root = h('div', { class: 'tree-root', title: S.project, onclick: () => { toggleExpand('!root-collapsed'); }, oncontextmenu: e => showCtx(e, { path: '', dir: true, name: S.projectName }) },
    h('span', { class: 'chev' + (rootOpen ? ' open' : ''), html: ICON.chev }), S.projectName);
  root.querySelector('.chev').style.cssText = 'width:16px;height:16px;display:grid;place-items:center;transition:transform .1s;' + (rootOpen ? 'transform:rotate(90deg)' : '');
  el.append(root);
  if (!rootOpen) return;
  const frag = document.createDocumentFragment();
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const open = n.dir && S.expanded.has(n.path);
      const row = h('div', {
        class: 'node' + (n.path === S.selected ? ' selected' : '') + (n.path === S.file ? ' active-file' : ''),
        'data-path': n.path, title: n.path, style: { paddingLeft: (8 + depth * 14) + 'px' },
        onclick: e => { e.stopPropagation(); selectNode(n.path); if (n.dir) toggleExpand(n.path); else openFile(n.path); },
        oncontextmenu: e => showCtx(e, n),
      },
      h('span', { class: 'chev' + (open ? ' open' : ''), html: n.dir ? ICON.chev : '' }),
      h('span', { class: 'icon', html: n.dir ? (open ? ICON.folderOpen : ICON.folder) : fileIcon(n.name) }),
      h('span', { class: 'name' }, n.name));
      frag.append(row);
      if (pendingCreate && pendingCreate.parent === n.path && open) frag.append(createRow(depth + 1));
      if (open) walk(n.children || [], depth + 1);
    }
  };
  if (pendingCreate && pendingCreate.parent === '') frag.append(createRow(0));
  walk(S.tree.children || [], 0);
  el.append(frag);
  if (pendingCreate) { const inp = el.querySelector('.node input'); if (inp) { inp.focus(); } }
  if (renameTarget) startRenameRow();
  updateDirty();
}

function toggleExpand(path) {
  if (S.expanded.has(path)) S.expanded.delete(path); else S.expanded.add(path);
  LS.set('expanded:' + S.project, [...S.expanded]);
  renderTree();
}

function selectNode(path) {
  S.selected = path;
  document.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
  const n = document.querySelector(`.node[data-path="${CSS.escape(path)}"]`);
  if (n) n.classList.add('selected');
}

function revealInTree(path) {
  const parts = path.split('/');
  let changed = false;
  for (let i = 1; i < parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (!S.expanded.has(p)) { S.expanded.add(p); changed = true; }
  }
  if (changed) LS.set('expanded:' + S.project, [...S.expanded]);
  S.selected = path;
  renderTree();
  const n = document.querySelector(`.node[data-path="${CSS.escape(path)}"]`);
  if (n) n.scrollIntoView({ block: 'nearest' });
}

// target folder for "new file/folder": selected folder, or parent of selected file
function targetFolder(explicit) {
  if (explicit != null) return explicit;
  const sel = S.selected && findNode(S.selected);
  if (!sel) return '';
  if (sel.dir) return sel.path;
  return sel.path.includes('/') ? sel.path.slice(0, sel.path.lastIndexOf('/')) : '';
}

let pendingCreate = null; // {parent, dir}
function createRow(depth) {
  const pc = pendingCreate;
  const input = h('input', { spellcheck: 'false', placeholder: pc.dir ? 'имя папки' : 'имя файла, напр. util.gocpy' });
  let done = false;
  const finish = async ok => {
    if (done) return; done = true;
    const name = input.value.trim();
    pendingCreate = null;
    if (!ok || !name) { renderTree(); return; }
    try {
      const r = await api('/api/fs/create', { parent: pc.parent, name, dir: pc.dir });
      if (pc.parent) S.expanded.add(pc.parent);
      if (pc.dir) S.expanded.add(r.path);
      await loadTree();
      if (!pc.dir) openFile(r.path); else revealInTree(r.path);
    } catch (e) { toast(e.message, 'error'); renderTree(); }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => setTimeout(() => finish(!!input.value.trim()), 0));
  return h('div', { class: 'node', style: { paddingLeft: (8 + depth * 14) + 'px' } },
    h('span', { class: 'chev', html: pc.dir ? ICON.chev : '' }), h('span', { class: 'icon', html: pc.dir ? ICON.folder : ICON.file }), input);
}

function startCreate(dir, parent) {
  if (!S.project) { toast('Сначала откройте проект'); return; }
  const p = targetFolder(parent);
  if (p) S.expanded.add(p);
  S.expanded.delete('!root-collapsed');
  pendingCreate = { parent: p, dir };
  renderTree();
}

let renameTarget = null;
function startRename(node) { renameTarget = node; renderTree(); }
function startRenameRow() {
  const node = renameTarget;
  renameTarget = null;
  const row = document.querySelector(`.node[data-path="${CSS.escape(node.path)}"]`);
  if (!row) return;
  const nameEl = row.querySelector('.name');
  const input = h('input', { value: node.name, spellcheck: 'false' });
  nameEl.replaceWith(input);
  input.focus();
  const dot = node.dir ? -1 : node.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  let done = false;
  const finish = async ok => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (!ok || !name || name === node.name) { renderTree(); return; }
    try {
      const r = await api('/api/fs/rename', { path: node.path, name });
      const wasOpen = S.file && (S.file === node.path || S.file.startsWith(node.path + '/'));
      if (wasOpen) S.file = r.path + S.file.slice(node.path.length);
      if (S.expanded.has(node.path)) { S.expanded.delete(node.path); S.expanded.add(r.path); }
      S.selected = r.path;
      await loadTree();
      if (wasOpen) { renderBreadcrumbs(); $('#sb-lang').textContent = LANG_NAMES[languageFor(S.file)]; api('/api/lastfile', { path: S.file }).catch(() => {}); }
    } catch (e) { toast(e.message, 'error'); renderTree(); }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

async function deleteNode(node) {
  const what = node.dir ? `папку «${node.name}» со всем содержимым` : `файл «${node.name}»`;
  const where = S.os === 'darwin' ? ' Она будет перемещена в Корзину.' : '';
  if (!(await confirmBox('Удалить?', `Удалить ${what}?${where.replace('Она', node.dir ? 'Она' : 'Он')}`, 'Удалить', true))) return;
  try {
    await api('/api/fs/delete', { path: node.path });
    if (S.file && (S.file === node.path || S.file.startsWith(node.path + '/'))) { editor.markSaved(); closeEditor(); }
    await loadTree();
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ context menu

function showCtx(e, node) {
  e.preventDefault(); e.stopPropagation();
  if (node.path) selectNode(node.path);
  const m = $('#ctxmenu');
  m.innerHTML = '';
  const folder = node.dir ? node.path : (node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '');
  const item = (label, fn, disabled) => h('button', { disabled, onclick: () => { hideCtx(); fn(); } }, label);
  m.append(
    item('Новый файл…', () => startCreate(false, folder)),
    item('Новая папка…', () => startCreate(true, folder)),
    h('hr'),
    node.path ? item('Переименовать…', () => startRename(node)) : null,
    node.path ? item('Удалить', () => deleteNode(node)) : null,
    node.path ? h('hr') : null,
    item(S.os === 'darwin' ? 'Показать в Finder' : 'Показать в файловом менеджере', () => api('/api/fs/reveal', { path: node.path }).catch(err => toast(err.message, 'error'))),
    item('Копировать путь', () => navigator.clipboard.writeText(S.project + (node.path ? '/' + node.path : '')).then(() => toast('Путь скопирован'))),
    item('Копировать относительный путь', () => navigator.clipboard.writeText(node.path || '.').then(() => toast('Путь скопирован'))),
  );
  m.classList.add('on');
  const { innerWidth: W, innerHeight: H } = window;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, W - r.width - 8) + 'px';
  m.style.top = Math.min(e.clientY, H - r.height - 8) + 'px';
}
function hideCtx() { $('#ctxmenu').classList.remove('on'); }
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxmenu')) hideCtx(); if (!e.target.closest('.menu')) closeMenus(); });
window.addEventListener('blur', () => { hideCtx(); closeMenus(); });

// ------------------------------------------------------------------ projects

function setProject(state) {
  S.project = state.project || '';
  S.projectName = S.project ? S.project.split('/').filter(Boolean).pop() || '/' : '';
  S.recent = state.recent || [];
  S.expanded = new Set(S.project ? LS.get('expanded:' + S.project, []) : []);
  $('#project-title').innerHTML = '';
  if (S.project) $('#project-title').append(h('b', {}, S.projectName), ' — ', tildify(S.project));
  $('#sb-project').textContent = S.project ? '⎇ ' + S.projectName : 'Нет проекта';
  $('#shell-cwd').textContent = S.project ? tildify(S.project) : '';
  $('#btn-run').disabled = !S.project;
  renderRecentMenu();
}

async function openProject(path) {
  if (!(await maybeSaveBeforeLeave())) return;
  try {
    const st = await api('/api/project/open', { path });
    await afterProjectChange(st);
  } catch (e) { toast('Не удалось открыть проект: ' + e.message, 'error'); }
}

async function afterProjectChange(st, preferFile) {
  editor.markSaved();
  S.file = '';
  setProject(st);
  await loadTree();
  const want = preferFile || st.lastFile;
  if (want && findNode(want)) await openFile(want, { force: true });
  else {
    const main = findNode('main.gocpy') || (S.tree && (S.tree.children || []).find(n => !n.dir && n.name.endsWith('.gocpy')));
    if (main) await openFile(main.path, { force: true }); else closeEditor();
  }
}

async function pickPath(kind, prompt, name) {
  if (S.os === 'darwin') {
    try {
      const r = await api('/api/pick', { kind, prompt, name });
      if (r.cancelled) return null;
      if (r.path) return r.path;
    } catch (e) { toast(e.message, 'error'); }
  }
  return undefined; // not supported -> caller shows a manual dialog
}

function pathDialog({ title, label, value, okLabel, hint, recent, browse }) {
  let input;
  let result = null;
  const body = h('div', { class: 'modal-body' });
  if (recent && recent.length) {
    body.append(h('div', { class: 'field' }, h('label', {}, 'Недавние проекты'),
      h('div', { class: 'recent-pick' }, recent.slice(0, 6).map(p => h('button', { onclick: () => { result = p; closeFn(p); } }, h('span', {}, p.split('/').pop()), h('span', { class: 'p' }, tildify(p)))))));
  }
  body.append(h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'row' }, input = h('input', { class: 'text mono', value: value || '', spellcheck: 'false' }),
      browse && S.os === 'darwin' ? h('button', { class: 'btn', onclick: async () => { const p = await browse(); if (p) input.value = p; } }, 'Обзор…') : null),
    hint ? h('div', { class: 'hint', html: hint }) : null));
  let closeFn;
  return modal({
    title, body,
    buttons: [{ label: 'Отмена' }, { label: okLabel, cls: 'primary', default: true, onClick: () => { result = input.value.trim(); } }],
    onOpen: (box, close) => { closeFn = close; input.focus(); input.select(); },
  }).then(() => result);
}

// ------------------------------------------------------------------ run

function setRunning(running, code, ms) {
  S.running = running;
  $('#btn-run').classList.toggle('running', running);
  $('#btn-run').querySelector('span').textContent = running ? 'Перезапустить' : 'Запустить';
  $('#btn-stop').disabled = !running;
  $('#statusbar').classList.toggle('running', running);
  const st = $('#run-status');
  st.className = 'run-status';
  st.innerHTML = '';
  if (running) { st.classList.add('running'); st.append(h('span', { class: 'dot' }), 'выполняется…'); $('#sb-run').textContent = '▶ Выполняется'; }
  else if (code != null && code !== -1) {
    st.classList.add(code === 0 ? 'ok' : 'fail');
    st.append(h('span', { class: 'dot' }), `код ${code}` + (ms != null ? ` · ${(ms / 1000).toFixed(2)} с` : ''));
    $('#sb-run').textContent = code === 0 ? '' : `✕ Код выхода ${code}`;
  } else { $('#sb-run').textContent = ''; }
}

async function runProgram() {
  if (!S.project) { toast('Сначала откройте проект'); return; }
  if (S.settings.saveOnRun !== false && S.file && editor.isDirty()) { if (!(await saveFile())) return; }
  try { await api('/api/run', { file: S.file }); } catch (e) { toast('Ошибка запуска: ' + e.message, 'error'); }
}

// ------------------------------------------------------------------ settings

async function openSettings(tab = 'general') {
  const draft = JSON.parse(JSON.stringify(S.settings));
  draft.colors = effectiveColors(draft.colors);
  const original = effectiveColors(S.settings.colors);
  const nav = h('div', { class: 'settings-nav' });
  const page = h('div', { class: 'settings-page' });
  const pages = {
    general: { title: 'Основные', render: renderGeneral },
    highlight: { title: 'Подсветка кода', render: renderHighlight },
    about: { title: 'О программе', render: renderAbout },
  };
  const show = id => {
    nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.id === id));
    page.innerHTML = '';
    page.scrollTop = 0;
    pages[id].render(page);
  };
  for (const [id, p] of Object.entries(pages)) nav.append(h('button', { 'data-id': id, onclick: () => show(id) }, p.title));

  function bindText(key, input, num) {
    input.addEventListener('input', () => { draft[key] = num ? Math.max(1, parseInt(input.value, 10) || 0) : input.value; });
    return input;
  }
  function bindCheck(key, label, hint) {
    const cb = h('input', { type: 'checkbox' }); cb.checked = !!draft[key];
    cb.addEventListener('change', () => { draft[key] = cb.checked; });
    return h('label', { class: 'check', title: hint || '' }, cb, label);
  }
  function renderGeneral(el) {
    el.append(
      h('h4', {}, 'Запуск'),
      h('div', { class: 'field' }, h('label', {}, 'Путь к компилятору gocpy'),
        bindText('gocpyPath', h('input', { class: 'text mono', value: draft.gocpyPath || '', placeholder: 'gocpy', spellcheck: 'false' })),
        h('div', { class: 'hint', html: 'Имя в <code>PATH</code> или полный путь, напр. <code>/usr/local/bin/gocpy</code> или <code>~/go/bin/gocpy</code>.' })),
      h('div', { class: 'field' }, h('label', {}, 'Команда запуска'),
        bindText('runCommand', h('input', { class: 'text mono', value: draft.runCommand || '', spellcheck: 'false' })),
        h('div', { class: 'hint', html: 'Выполняется в login-shell в папке проекта. Подстановки: <code>{gocpy}</code> — компилятор, <code>{project}</code> — папка проекта, <code>{file}</code> — открытый файл, <code>{dir}</code> — папка файла, <code>{name}</code> — имя проекта. Примеры: <code>{gocpy} run {project}</code>, <code>{gocpy} build -o bin/{name} {project} &amp;&amp; ./bin/{name}</code>.' })),
      h('div', { class: 'grid2' },
        bindCheck('saveOnRun', 'Сохранять файл перед запуском'),
        bindCheck('clearOnRun', 'Очищать вывод перед запуском')),
      h('h4', { style: { marginTop: '18px' } }, 'Редактор'),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', {}, 'Шрифт'), bindText('fontFamily', h('input', { class: 'text', value: draft.fontFamily || '' }))),
        h('div', { class: 'field' }, h('label', {}, 'Размер шрифта редактора'), bindText('fontSize', h('input', { class: 'text', type: 'number', min: 8, max: 40, value: draft.fontSize || 13 }), true)),
        h('div', { class: 'field' }, h('label', {}, 'Ширина табуляции'), bindText('tabSize', h('input', { class: 'text', type: 'number', min: 1, max: 16, value: draft.tabSize || 4 }), true)),
        h('div', { class: 'field' }, h('label', {}, 'Размер шрифта терминалов'), bindText('termFontSize', h('input', { class: 'text', type: 'number', min: 8, max: 32, value: draft.termFontSize || 12 }), true)),
      ),
      h('div', { class: 'grid2' },
        bindCheck('useTabs', 'Отступ табами (как в gofmt)'),
        bindCheck('wordWrap', 'Перенос длинных строк'),
        bindCheck('showHidden', 'Показывать скрытые файлы в проводнике')),
      h('h4', { style: { marginTop: '18px' } }, 'Терминал'),
      h('div', { class: 'field' }, h('label', {}, 'Shell'),
        bindText('shell', h('input', { class: 'text mono', value: draft.shell || '', placeholder: 'по умолчанию $SHELL (обычно /bin/zsh)', spellcheck: 'false' })),
        h('div', { class: 'hint' }, 'Применится после перезапуска терминала.')),
    );
  }
  function renderHighlight(el) {
    const filter = h('input', { class: 'text', placeholder: 'Фильтр: unsafe, тип, строки…', spellcheck: 'false' });
    const table = h('table', { class: 'hl-table' });
    const rows = [];
    const apply = () => applyColors(draft.colors);
    const resetAll = h('button', { class: 'btn', onclick: () => {
      draft.colors = { ...DEFAULT_COLORS }; apply(); rows.forEach(r => r.sync());
    } }, 'Сбросить все цвета');
    el.append(h('div', { class: 'hl-toolbar' }, filter, h('span', { style: { flex: 1 } }), resetAll));
    table.append(h('thead', {}, h('tr', {}, h('th', {}, 'Что подсвечиваем'), h('th', {}, 'Пример'), h('th', {}, 'Цвет'))));
    const tbody = h('tbody');
    for (const g of GROUPS) {
      const groupRow = h('tr', { class: 'group' }, h('td', { colspan: 3 }, g.name));
      tbody.append(groupRow);
      const members = [];
      for (const c of CATEGORIES.filter(x => x.group === g.id)) {
        const swatch = h('span', { class: 'swatch' });
        const picker = h('input', { type: 'color', value: draft.colors[c.id] });
        swatch.append(picker);
        const hex = h('input', { class: 'hex', value: draft.colors[c.id], spellcheck: 'false', maxlength: 7 });
        const reset = h('button', { class: 'reset1', title: 'Вернуть цвет по умолчанию (' + c.color + ')', html: '↺' });
        const sample = c.kind === 'bg'
          ? h('span', { class: 'sample bgsample' })
          : h('span', { class: 'sample t-' + c.id }, c.example || c.name);
        const tr = h('tr', {}, h('td', { class: 'what' }, c.name, h('small', {}, c.kind === 'bg' ? 'цвет фона' : '')), h('td', {}, sample),
          h('td', { class: 'colorcell' }, swatch, hex, reset));
        const sync = () => {
          const v = draft.colors[c.id];
          picker.value = v; hex.value = v; hex.classList.remove('bad');
          swatch.style.background = v;
          if (c.kind === 'bg') sample.style.background = v;
          else if (c.id.startsWith('ui-')) sample.style.color = v;
          tr.classList.toggle('modified', v.toLowerCase() !== c.color.toLowerCase());
        };
        const setColor = v => { draft.colors[c.id] = v.toLowerCase(); apply(); sync(); };
        picker.addEventListener('input', () => setColor(picker.value));
        hex.addEventListener('input', () => {
          let v = hex.value.trim(); if (!v.startsWith('#')) v = '#' + v;
          if (/^#[0-9a-fA-F]{6}$/.test(v)) { draft.colors[c.id] = v.toLowerCase(); apply(); picker.value = v; swatch.style.background = v; if (c.kind === 'bg') sample.style.background = v; tr.classList.toggle('modified', v.toLowerCase() !== c.color); hex.classList.remove('bad'); }
          else hex.classList.add('bad');
        });
        hex.addEventListener('blur', sync);
        reset.addEventListener('click', () => setColor(c.color));
        sync();
        const text = (c.name + ' ' + c.example + ' ' + c.id + ' ' + g.name).toLowerCase();
        rows.push({ tr, sync, text, group: groupRow });
        members.push(tr);
        tbody.append(tr);
      }
      groupRow._members = members;
    }
    table.append(tbody);
    el.append(table);
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) r.tr.style.display = !q || r.text.includes(q) ? '' : 'none';
      tbody.querySelectorAll('tr.group').forEach(g => { g.style.display = g._members.some(m => m.style.display !== 'none') ? '' : 'none'; });
    });
    setTimeout(() => filter.focus(), 0);
  }
  function renderAbout(el) {
    el.append(h('h4', {}, 'Gocpy IDE ' + (S.version || '')),
      h('p', { style: { color: 'var(--fg-dim)', lineHeight: 1.6 } }, 'Лёгкая среда разработки для языка gocpy: проводник проекта, редактор с семантической подсветкой, терминал и вывод программы.'),
      h('p', { style: { color: 'var(--fg-dim)', lineHeight: 1.6 } }, 'Настройки хранятся в ~/Library/Application Support/GocpyIDE/settings.json.'));
  }

  const body = h('div', { class: 'settings' }, nav, page);
  const ok = await modal({
    title: 'Настройки', wide: true, body,
    buttons: [{ label: 'Отмена', value: false }, { label: 'Сохранить', cls: 'primary', value: true }],
    onOpen: () => show(tab),
  });
  if (!ok) { applyColors(original); return; }
  // store only colors that differ from defaults
  const colors = {};
  for (const [k, v] of Object.entries(draft.colors)) if (DEFAULT_COLORS[k] !== v) colors[k] = v;
  draft.colors = colors;
  const shellChanged = (draft.shell || '') !== (S.settings.shell || '');
  const hiddenChanged = draft.showHidden !== S.settings.showHidden;
  try {
    S.settings = await api('/api/settings', draft, 'PUT');
    applySettingsToUI();
    if (hiddenChanged) loadTree();
    if (shellChanged) shellTerm.restart();
    toast('Настройки сохранены', 'ok');
  } catch (e) { toast(e.message, 'error'); applyColors(original); }
}

// ------------------------------------------------------------------ commands

const cmd = {
  async newProject() {
    if (!(await maybeSaveBeforeLeave())) return;
    let p = await pickPath('new', 'Новый проект gocpy — укажите имя и расположение папки', 'my-gocpy-app');
    if (p === null) return;
    if (p === undefined) p = await pathDialog({ title: 'Новый проект', label: 'Папка нового проекта (будет создана)', value: (S.home || '~') + '/gocpy/my-app', okLabel: 'Создать', hint: 'Будут созданы <code>main.gocpy</code>, <code>gocpy.yml</code> и <code>.gitignore</code>.' });
    if (!p) return;
    try { const st = await api('/api/project/new', { path: p }); await afterProjectChange(st, 'main.gocpy'); toast('Проект создан', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  },
  async openProject() {
    let p = await pickPath('folder', 'Выберите папку проекта gocpy');
    if (p === null) return;
    if (p === undefined) p = await pathDialog({ title: 'Открыть проект', label: 'Путь к папке проекта', value: S.project || S.home || '', okLabel: 'Открыть', recent: S.recent, browse: () => pickPath('folder') });
    if (p) openProject(p);
  },
  async saveProjectAs() {
    if (!S.project) return;
    if (!(await saveFile())) return;
    let p = await pickPath('new', 'Сохранить копию проекта как…', S.projectName + '-copy');
    if (p === null) return;
    if (p === undefined) p = await pathDialog({ title: 'Сохранить проект как', label: 'Новая папка проекта', value: S.project + '-copy', okLabel: 'Сохранить', hint: 'Весь проект будет скопирован в новую папку, и она откроется.' });
    if (!p) return;
    const cur = S.file;
    try { const st = await api('/api/project/saveas', { path: p }); await afterProjectChange(st, cur); toast('Проект сохранён в ' + tildify(p), 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  },
  async closeProject() {
    if (!(await maybeSaveBeforeLeave())) return;
    await api('/api/project/close', {});
    editor.markSaved();
    const st = await api('/api/state');
    setProject(st); S.tree = null; renderTree(); closeEditor();
  },
  revealProject() { if (S.project) api('/api/fs/reveal', { path: '' }); },
  newFile: () => startCreate(false),
  newFolder: () => startCreate(true),
  save: () => saveFile(),
  refreshTree: () => loadTree(),
  collapseAll() { S.expanded.clear(); LS.set('expanded:' + S.project, []); renderTree(); },
  settings: () => openSettings(),
  run: () => runProgram(),
  stop: () => api('/api/stop', {}).catch(() => {}),
  clearShell: () => shellTerm.clear(),
  restartShell: () => shellTerm.restart(),
  clearRun: () => runTerm.clear(),
  undo: () => { undo(editor.view); editor.focus(); },
  redo: () => { redo(editor.view); editor.focus(); },
  find: () => { openSearchPanel(editor.view); },
  gotoLine: () => { gotoLine(editor.view); },
  comment: () => { toggleComment(editor.view); editor.focus(); },
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-cmd]');
  if (!b || b.disabled) return;
  closeMenus();
  const c = cmd[b.dataset.cmd];
  if (c) c();
});

// menus
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
document.querySelectorAll('.menu > .menu-btn').forEach(btn => {
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    const m = btn.parentElement;
    const was = m.classList.contains('open');
    closeMenus();
    if (!was) m.classList.add('open');
  });
  btn.addEventListener('mouseenter', () => {
    if (document.querySelector('.menu.open') && !btn.parentElement.classList.contains('open')) { closeMenus(); btn.parentElement.classList.add('open'); }
  });
});

function renderRecentMenu() {
  const list = $('#recent-list');
  list.innerHTML = '';
  if (!S.recent.length) { list.append(h('div', { class: 'empty' }, 'Пусто')); return; }
  for (const p of S.recent) list.append(h('button', { title: p, onclick: () => { closeMenus(); openProject(p); } }, tildify(p)));
}

// global shortcuts
document.addEventListener('keydown', e => {
  const mod = e.metaKey || (S.os !== 'darwin' && e.ctrlKey);
  const k = e.key.toLowerCase();
  if ($('#overlay').classList.contains('on')) return;
  if (mod && !e.shiftKey && !e.altKey && k === 's') { e.preventDefault(); saveFile(); }
  else if ((mod && k === 'r') || (e.key === 'F5' && !e.shiftKey)) { e.preventDefault(); runProgram(); }
  else if ((e.key === 'F5' && e.shiftKey) || (mod && k === '.')) { e.preventDefault(); cmd.stop(); }
  else if (mod && k === 'o') { e.preventDefault(); cmd.openProject(); }
  else if (mod && k === ',') { e.preventDefault(); openSettings(); }
  else if (mod && e.altKey && (k === 'n' || e.code === 'KeyN')) { e.preventDefault(); cmd.newFile(); }
  else if (e.target === $('#tree') && S.selected) {
    const node = findNode(S.selected);
    if (!node) return;
    if (e.key === 'Enter') { e.preventDefault(); startRename(node); }
    else if ((e.key === 'Backspace' && e.metaKey) || e.key === 'Delete') { e.preventDefault(); deleteNode(node); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...document.querySelectorAll('#tree .node[data-path]')];
      const i = rows.findIndex(r => r.dataset.path === S.selected);
      const nx = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (nx) { selectNode(nx.dataset.path); nx.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'ArrowRight' && node.dir && !S.expanded.has(node.path)) toggleExpand(node.path);
    else if (e.key === 'ArrowLeft' && node.dir && S.expanded.has(node.path)) toggleExpand(node.path);
    else if (e.key === ' ' && !node.dir) { e.preventDefault(); openFile(node.path); }
  }
});

window.addEventListener('beforeunload', e => { if (S.file && editor.isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ splitters

function splitter(el, axis, varName, container, min, max) {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    el.classList.add('dragging');
    document.body.classList.add('resizing', axis === 'x' ? 'col' : 'row');
    const rect = container().getBoundingClientRect();
    const move = ev => {
      let frac;
      if (axis === 'x') frac = (ev.clientX - rect.left) / rect.width;
      else frac = (rect.bottom - ev.clientY) / rect.height;
      frac = Math.min(max, Math.max(min, frac));
      document.documentElement.style.setProperty(varName, (frac * 100).toFixed(2) + '%');
    };
    const up = () => {
      el.classList.remove('dragging');
      document.body.classList.remove('resizing', 'col', 'row');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      LS.set('layout:' + varName, getComputedStyle(document.documentElement).getPropertyValue(varName).trim());
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  el.addEventListener('dblclick', () => {
    const def = { '--tree-w': '25%', '--bottom-h': '30%', '--terms-split': '50%' }[varName];
    document.documentElement.style.setProperty(varName, def);
    LS.set('layout:' + varName, def);
  });
  const saved = LS.get('layout:' + varName, null);
  if (saved) document.documentElement.style.setProperty(varName, saved);
}
splitter($('#split-side'), 'x', '--tree-w', () => $('#top'), 0.12, 0.6);
splitter($('#split-bottom'), 'y', '--bottom-h', () => $('#workbench'), 0.1, 0.8);
splitter($('#split-terms'), 'x', '--terms-split', () => $('#bottom'), 0.15, 0.85);

// ------------------------------------------------------------------ events

function connectEvents() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/events?token=${encodeURIComponent(TOKEN)}`);
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'run') setRunning(m.running, m.code, m.ms);
  };
  ws.onclose = () => setTimeout(connectEvents, 1000);
}

// refresh the tree when the window regains focus (e.g. after git checkout)
let lastTreeRefresh = 0;
window.addEventListener('focus', () => { if (S.project && Date.now() - lastTreeRefresh > 1500) { lastTreeRefresh = Date.now(); loadTree(); checkExternalChange(); } });
async function checkExternalChange() {
  if (!S.file) return;
  try {
    const r = await api('/api/file?path=' + encodeURIComponent(S.file));
    if (r.mtime && r.mtime !== S.fileMtime && r.content !== editor.text()) {
      if (!editor.isDirty()) { const sel = editor.view.state.selection.main.head; editor.load(r.content, languageFor(S.file)); S.fileMtime = r.mtime; editor.view.dispatch({ selection: { anchor: Math.min(sel, r.content.length) } }); applySettingsToUI(); toast('Файл обновлён с диска'); }
      else { S.fileMtime = r.mtime; toast(`«${S.file}» изменён на диске. Сохранение перезапишет его.`); }
    }
  } catch { /* file deleted */ }
}

// ------------------------------------------------------------------ boot

let shellTerm, runTerm;
(async function boot() {
  if (!TOKEN) { document.body.innerHTML = '<p style="padding:24px">Нет токена доступа. Запустите Gocpy IDE заново.</p>'; return; }
  let st;
  try { st = await api('/api/state'); } catch (e) { document.body.innerHTML = `<p style="padding:24px">Сервер IDE недоступен: ${e.message}</p>`; return; }
  S.settings = st.settings; S.os = st.os; S.home = st.home; S.version = st.version;
  applySettingsToUI();
  shellTerm = new TermView($('#term-shell'), 'shell', TOKEN, { fontSize: S.settings.termFontSize || 12 });
  runTerm = new TermView($('#term-run'), 'run', TOKEN, { fontSize: S.settings.termFontSize || 12 });
  applySettingsToUI();
  connectEvents();
  setRunning(!!st.running);
  setProject(st);
  if (st.project) await afterProjectChange(st);
  else { renderTree(); closeEditor(); }
})();
