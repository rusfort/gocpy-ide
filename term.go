package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 32 * 1024}

const replayLimit = 256 * 1024

type client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *client) send(kind int, b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.conn.WriteMessage(kind, b)
}

// Term is a PTY-backed terminal session shared by any number of browser clients.
//   kind "shell": a persistent interactive login shell in the project directory.
//   kind "run":   the output of the program started with the Run button.
type Term struct {
	kind string
	app  *App

	mu      sync.Mutex
	clients map[*client]bool
	buf     []byte
	ptmx    *os.File
	cmd     *exec.Cmd
	gen     int
	cols    uint16
	rows    uint16
	started time.Time
	exited  bool
}

func newTerm(kind string, app *App) *Term {
	return &Term{kind: kind, app: app, clients: map[*client]bool{}, cols: 80, rows: 24}
}

func (t *Term) Running() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cmd != nil
}

func (t *Term) write(b []byte) {
	t.mu.Lock()
	t.buf = append(t.buf, b...)
	if len(t.buf) > replayLimit {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-replayLimit:]...)
	}
	cs := make([]*client, 0, len(t.clients))
	for c := range t.clients {
		cs = append(cs, c)
	}
	t.mu.Unlock()
	for _, c := range cs {
		_ = c.send(websocket.BinaryMessage, b)
	}
}

func (t *Term) control(v any) {
	b, _ := json.Marshal(v)
	t.mu.Lock()
	cs := make([]*client, 0, len(t.clients))
	for c := range t.clients {
		cs = append(cs, c)
	}
	t.mu.Unlock()
	for _, c := range cs {
		_ = c.send(websocket.TextMessage, b)
	}
}

// Reset clears the scrollback for all clients.
func (t *Term) Reset() {
	t.mu.Lock()
	t.buf = nil
	n := len(t.clients)
	t.mu.Unlock()
	t.control(map[string]string{"type": "reset"})
	if t.kind == "shell" && n > 0 {
		t.startShell()
	}
}

func baseEnv() []string {
	env := os.Environ()
	set := func(k, v string) {
		for i, e := range env {
			if strings.HasPrefix(e, k+"=") {
				env[i] = k + "=" + v
				return
			}
		}
		env = append(env, k+"="+v)
	}
	set("TERM", "xterm-256color")
	set("COLORTERM", "truecolor")
	set("TERM_PROGRAM", "GocpyIDE")
	if os.Getenv("LANG") == "" {
		set("LANG", "en_US.UTF-8")
	}
	// Apps started from Finder get a minimal PATH; add the usual tool locations.
	home, _ := os.UserHomeDir()
	extra := []string{"/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/go/bin",
		filepath.Join(home, "go", "bin"), filepath.Join(home, ".local", "bin")}
	path := os.Getenv("PATH")
	have := map[string]bool{}
	for _, p := range filepath.SplitList(path) {
		have[p] = true
	}
	for _, p := range extra {
		if !have[p] {
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				path += string(os.PathListSeparator) + p
			}
		}
	}
	set("PATH", path)
	return env
}

func (t *Term) spawn(cmd *exec.Cmd, onExit func(code int, d time.Duration)) error {
	cmd.Env = baseEnv()
	t.mu.Lock()
	size := &pty.Winsize{Cols: t.cols, Rows: t.rows}
	t.mu.Unlock()
	ptmx, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.gen++
	gen := t.gen
	t.ptmx, t.cmd, t.started, t.exited = ptmx, cmd, time.Now(), false
	t.mu.Unlock()

	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				t.write(append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				break
			}
		}
		err := cmd.Wait()
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
				if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
					code = 128 + int(ws.Signal())
				}
			} else {
				code = -1
			}
		}
		ptmx.Close()
		t.mu.Lock()
		current := t.gen == gen
		d := time.Since(t.started)
		if current {
			t.ptmx, t.cmd, t.exited = nil, nil, true
		}
		t.mu.Unlock()
		if current && onExit != nil {
			onExit(code, d)
		}
	}()
	return nil
}

func (t *Term) startShell() {
	t.mu.Lock()
	if t.cmd != nil {
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()
	dir := t.app.Project()
	if dir == "" {
		dir, _ = os.UserHomeDir()
	}
	sh := t.app.userShell()
	cmd := exec.Command(sh, "-l")
	cmd.Dir = dir
	if err := t.spawn(cmd, func(code int, d time.Duration) {
		t.write([]byte("\r\n\x1b[90m[shell завершён — нажмите Enter для перезапуска]\x1b[0m\r\n"))
	}); err != nil {
		t.write([]byte(fmt.Sprintf("\x1b[31mне удалось запустить %s: %v\x1b[0m\r\n", sh, err)))
	}
}

// StartCommand runs cmdline via the user's login shell (kind "run").
func (t *Term) StartCommand(cmdline, dir string, clear bool) error {
	t.Kill()
	time.Sleep(30 * time.Millisecond)
	if clear {
		t.mu.Lock()
		t.buf = nil
		t.mu.Unlock()
		t.control(map[string]string{"type": "reset"})
	}
	t.write([]byte("\x1b[38;5;244m$ " + strings.ReplaceAll(cmdline, "\n", "\r\n") + "\x1b[0m\r\n"))
	sh := t.app.userShell()
	cmd := exec.Command(sh, "-l", "-c", cmdline)
	cmd.Dir = dir
	err := t.spawn(cmd, func(code int, d time.Duration) {
		color := "32"
		if code != 0 {
			color = "31"
		}
		t.write([]byte(fmt.Sprintf("\r\n\x1b[%sm■ Процесс завершён с кодом %d\x1b[0m \x1b[90m(%.2f с)\x1b[0m\r\n", color, code, d.Seconds())))
		t.app.events.broadcast(map[string]any{"type": "run", "running": false, "code": code, "ms": d.Milliseconds()})
	})
	if err != nil {
		t.write([]byte(fmt.Sprintf("\x1b[31mошибка запуска: %v\x1b[0m\r\n", err)))
		return err
	}
	t.app.events.broadcast(map[string]any{"type": "run", "running": true})
	return nil
}

// Interrupt sends SIGINT to the process group, then SIGKILL if it does not exit.
func (t *Term) Interrupt() {
	t.mu.Lock()
	cmd, gen := t.cmd, t.gen
	t.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGINT)
	_ = cmd.Process.Signal(syscall.SIGINT)
	go func() {
		time.Sleep(1500 * time.Millisecond)
		t.mu.Lock()
		still := t.cmd != nil && t.gen == gen
		t.mu.Unlock()
		if still {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			_ = cmd.Process.Kill()
		}
	}()
}

// Kill terminates the session immediately.
func (t *Term) Kill() {
	t.mu.Lock()
	cmd, ptmx := t.cmd, t.ptmx
	t.cmd, t.ptmx = nil, nil
	t.gen++
	t.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
		_ = cmd.Process.Kill()
	}
	if ptmx != nil {
		ptmx.Close()
	}
	if cmd != nil && t.kind == "run" {
		t.app.events.broadcast(map[string]any{"type": "run", "running": false, "code": -1})
	}
}

func (t *Term) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("token") != t.app.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn}
	t.mu.Lock()
	replay := append([]byte(nil), t.buf...)
	t.clients[c] = true
	t.mu.Unlock()
	if len(replay) > 0 {
		_ = c.send(websocket.BinaryMessage, replay)
	}
	defer func() {
		t.mu.Lock()
		delete(t.clients, c)
		t.mu.Unlock()
		conn.Close()
	}()
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var m struct {
			T string `json:"t"`
			D string `json:"d"`
			C uint16 `json:"c"`
			R uint16 `json:"r"`
		}
		if json.Unmarshal(msg, &m) != nil {
			continue
		}
		switch m.T {
		case "i":
			t.mu.Lock()
			ptmx := t.ptmx
			t.mu.Unlock()
			if ptmx == nil && t.kind == "shell" {
				t.startShell()
				continue
			}
			if ptmx != nil {
				if _, err := ptmx.Write([]byte(m.D)); err != nil {
					log.Printf("pty write: %v", err)
				}
			}
		case "r":
			if m.C == 0 || m.R == 0 {
				continue
			}
			t.mu.Lock()
			t.cols, t.rows = m.C, m.R
			ptmx := t.ptmx
			t.mu.Unlock()
			if ptmx != nil {
				_ = pty.Setsize(ptmx, &pty.Winsize{Cols: m.C, Rows: m.R})
			}
			if t.kind == "shell" {
				t.mu.Lock()
				need := t.ptmx == nil && !t.exited
				t.mu.Unlock()
				if need {
					t.startShell()
				}
			}
		case "start":
			if t.kind == "shell" {
				t.Kill()
				t.mu.Lock()
				t.buf = nil
				t.exited = false
				t.mu.Unlock()
				t.control(map[string]string{"type": "reset"})
				t.startShell()
			}
		}
	}
}

// ------------------------------------------------------------------ events hub

// Hub broadcasts IDE events and detects when the window was closed.
type Hub struct {
	app     *App
	mu      sync.Mutex
	clients map[*client]bool
	ever    bool
	idleGen int
}

func newHub(a *App) *Hub { return &Hub{app: a, clients: map[*client]bool{}} }

func (h *Hub) everConnected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ever
}

func (h *Hub) broadcast(v any) {
	b, _ := json.Marshal(v)
	h.mu.Lock()
	cs := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		cs = append(cs, c)
	}
	h.mu.Unlock()
	for _, c := range cs {
		_ = c.send(websocket.TextMessage, b)
	}
}

func (h *Hub) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("token") != h.app.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn}
	h.mu.Lock()
	h.clients[c] = true
	h.ever = true
	h.idleGen++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.idleGen++
		gen, n := h.idleGen, len(h.clients)
		h.mu.Unlock()
		conn.Close()
		if n == 0 {
			go func() {
				time.Sleep(5 * time.Second)
				h.mu.Lock()
				idle := h.idleGen == gen && len(h.clients) == 0
				h.mu.Unlock()
				if idle && h.app.OnIdle != nil {
					h.app.OnIdle()
				}
			}()
		}
	}()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
