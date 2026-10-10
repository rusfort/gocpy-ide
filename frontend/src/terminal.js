import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const THEME = {
  background: '#181818', foreground: '#cccccc', cursor: '#aeafad', cursorAccent: '#181818',
  selectionBackground: '#264f78',
  black: '#000000', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6',
  cyan: '#29b8db', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
  brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};

// PTY-backed terminal connected to /ws/term/<kind>.
export class TermView {
  constructor(el, kind, token, { fontSize = 12, fontFamily, onTitle } = {}) {
    this.el = el; this.kind = kind; this.token = token;
    this.term = new Terminal({
      fontSize, fontFamily: fontFamily || 'SF Mono, Menlo, Monaco, monospace', theme: THEME,
      cursorBlink: kind === 'shell', scrollback: 10000, allowProposedApi: true, macOptionIsMeta: true,
      convertEol: false, cursorStyle: kind === 'shell' ? 'block' : 'bar', cursorInactiveStyle: 'outline',
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(el);
    if (onTitle) this.term.onTitleChange(onTitle);
    this.term.onData(d => this.send({ t: 'i', d }));
    this.term.attachCustomKeyEventHandler(e => {
      // let IDE shortcuts through (⌘S, ⌘R, ⌘O, ⌘,)
      if ((e.metaKey || e.ctrlKey) && ['s', 'r', 'o', ','].includes(e.key.toLowerCase()) && e.metaKey) return false;
      if (e.key === 'F5') return false;
      // ⌘K clears the terminal like in Terminal.app
      if (e.type === 'keydown' && e.metaKey && e.key.toLowerCase() === 'k') { this.term.clear(); return false; }
      return true;
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.retry = 0;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/term/${this.kind}?token=${encodeURIComponent(this.token)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.term.reset();
      this.resize(true);
    };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'reset') this.term.reset();
      } else {
        this.term.write(new Uint8Array(ev.data));
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      const delay = Math.min(3000, 200 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  resize(force) {
    if (!this.el.offsetWidth || !this.el.offsetHeight) return;
    try { this.fit.fit(); } catch { return; }
    const { cols, rows } = this.term;
    if (force || cols !== this.lastCols || rows !== this.lastRows) {
      this.lastCols = cols; this.lastRows = rows;
      this.send({ t: 'r', c: cols, r: rows });
    }
  }

  setFont(size, family) {
    this.term.options.fontSize = size;
    if (family) this.term.options.fontFamily = family;
    this.resize(true);
  }

  clear() { this.term.clear(); }
  restart() { this.send({ t: 'start' }); }
  focus() { this.term.focus(); }
}
