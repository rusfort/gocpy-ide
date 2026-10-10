package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Settings are persisted in <config>/settings.json. Colors is a free-form map
// "category id" -> "#rrggbb" maintained by the UI.
type Settings struct {
	GocpyPath   string            `json:"gocpyPath"`
	RunCommand  string            `json:"runCommand"`
	Shell       string            `json:"shell"`
	FontFamily  string            `json:"fontFamily"`
	FontSize    int               `json:"fontSize"`
	TermFont    int               `json:"termFontSize"`
	TabSize     int               `json:"tabSize"`
	UseTabs     bool              `json:"useTabs"`
	SaveOnRun   bool              `json:"saveOnRun"`
	ClearOnRun  bool              `json:"clearOnRun"`
	ShowHidden  bool              `json:"showHidden"`
	WordWrap    bool              `json:"wordWrap"`
	Colors      map[string]string `json:"colors"`
	ExtraFields map[string]any    `json:"extra,omitempty"`
}

func defaultSettings() Settings {
	return Settings{
		GocpyPath:  "gocpy",
		RunCommand: "{gocpy} run {project}",
		Shell:      "",
		FontFamily: "SF Mono, Menlo, Monaco, Consolas, monospace",
		FontSize:   13,
		TermFont:   12,
		TabSize:    4,
		UseTabs:    true,
		SaveOnRun:  true,
		ClearOnRun: true,
		ShowHidden: false,
		Colors:     map[string]string{},
	}
}

// State is the persisted session state (recent projects, last project).
type State struct {
	LastProject string   `json:"lastProject"`
	Recent      []string `json:"recent"`
	LastFile    map[string]string `json:"lastFile"`
}

type App struct {
	token string
	cfg   string

	mu       sync.Mutex
	settings Settings
	state    State
	project  string

	shell *Term
	run   *Term

	events *Hub
	OnIdle func()
}

func NewApp(token string) (*App, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	cfg := filepath.Join(base, "GocpyIDE")
	if err := os.MkdirAll(cfg, 0o755); err != nil {
		return nil, err
	}
	a := &App{token: token, cfg: cfg, settings: defaultSettings()}
	a.loadJSON("settings.json", &a.settings)
	if a.settings.Colors == nil {
		a.settings.Colors = map[string]string{}
	}
	a.loadJSON("state.json", &a.state)
	if a.state.LastFile == nil {
		a.state.LastFile = map[string]string{}
	}
	a.events = newHub(a)
	a.shell = newTerm("shell", a)
	a.run = newTerm("run", a)
	return a, nil
}

func (a *App) ConfigDir() string { return a.cfg }

func (a *App) loadJSON(name string, v any) {
	b, err := os.ReadFile(filepath.Join(a.cfg, name))
	if err == nil {
		_ = json.Unmarshal(b, v)
	}
}

func (a *App) saveJSON(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(a.cfg, name+".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(a.cfg, name))
}

func (a *App) EverConnected() bool { return a.events.everConnected() }

func (a *App) Shutdown() {
	a.shell.Kill()
	a.run.Kill()
}

// OpenProject switches the current project directory.
func (a *App) OpenProject(dir string) error {
	dir = filepath.Clean(dir)
	st, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	a.mu.Lock()
	a.project = dir
	a.state.LastProject = dir
	rec := []string{dir}
	for _, r := range a.state.Recent {
		if r != dir && len(rec) < 12 {
			rec = append(rec, r)
		}
	}
	a.state.Recent = rec
	_ = a.saveJSON("state.json", a.state)
	a.mu.Unlock()
	// restart the interactive shell in the new project directory
	a.shell.Kill()
	a.run.Kill()
	a.shell.Reset()
	a.run.Reset()
	a.events.broadcast(map[string]any{"type": "project", "path": dir})
	return nil
}

func (a *App) Project() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.project
}

func (a *App) Settings() Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settings
}

// resolve maps a project-relative path to an absolute path inside the project.
func (a *App) resolve(rel string) (string, error) {
	root := a.Project()
	if root == "" {
		return "", errors.New("проект не открыт")
	}
	rel = filepath.FromSlash(strings.TrimPrefix(rel, "/"))
	p := filepath.Clean(filepath.Join(root, rel))
	if p != root && !strings.HasPrefix(p, root+string(filepath.Separator)) {
		return "", errors.New("путь вне проекта")
	}
	return p, nil
}

// ------------------------------------------------------------------ HTTP

func (a *App) Routes(mux *http.ServeMux) {
	h := func(path string, fn func(w http.ResponseWriter, r *http.Request) (any, error)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Token") != a.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			res, err := fn(w, r)
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			if res == nil {
				res = map[string]bool{"ok": true}
			}
			_ = json.NewEncoder(w).Encode(res)
		})
	}

	h("/api/state", a.apiState)
	h("/api/settings", a.apiSettings)
	h("/api/project/open", a.apiOpen)
	h("/api/project/close", a.apiClose)
	h("/api/project/new", a.apiNew)
	h("/api/project/saveas", a.apiSaveAs)
	h("/api/pick", a.apiPick)
	h("/api/tree", a.apiTree)
	h("/api/file", a.apiFile)
	h("/api/fs/create", a.apiCreate)
	h("/api/fs/rename", a.apiRename)
	h("/api/fs/delete", a.apiDelete)
	h("/api/fs/reveal", a.apiReveal)
	h("/api/run", a.apiRun)
	h("/api/stop", a.apiStop)
	h("/api/lastfile", a.apiLastFile)

	mux.HandleFunc("/ws/events", a.events.serve)
	mux.HandleFunc("/ws/term/shell", a.shell.serve)
	mux.HandleFunc("/ws/term/run", a.run.serve)
}

func decode(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(v)
}

func (a *App) apiState(w http.ResponseWriter, r *http.Request) (any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	home, _ := os.UserHomeDir()
	recent := []string{}
	for _, p := range a.state.Recent {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			recent = append(recent, p)
		}
	}
	return map[string]any{
		"project":  a.project,
		"recent":   recent,
		"settings": a.settings,
		"home":     home,
		"os":       runtime.GOOS,
		"version":  version,
		"running":  a.run.Running(),
		"lastFile": a.state.LastFile[a.project],
	}, nil
}

func (a *App) apiSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	if r.Method == http.MethodGet {
		return a.Settings(), nil
	}
	s := defaultSettings()
	if err := decode(r, &s); err != nil {
		return nil, err
	}
	if s.Colors == nil {
		s.Colors = map[string]string{}
	}
	a.mu.Lock()
	a.settings = s
	err := a.saveJSON("settings.json", s)
	a.mu.Unlock()
	return s, err
}

func (a *App) apiLastFile(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.project != "" {
		a.state.LastFile[a.project] = req.Path
		_ = a.saveJSON("state.json", a.state)
	}
	return nil, nil
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return p
}

func (a *App) apiOpen(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	p := expandHome(strings.TrimSpace(req.Path))
	if !filepath.IsAbs(p) {
		return nil, errors.New("укажите абсолютный путь к папке проекта")
	}
	if err := a.OpenProject(p); err != nil {
		return nil, err
	}
	return a.apiState(w, r)
}

func (a *App) apiClose(w http.ResponseWriter, r *http.Request) (any, error) {
	a.mu.Lock()
	a.project = ""
	a.state.LastProject = ""
	_ = a.saveJSON("state.json", a.state)
	a.mu.Unlock()
	a.shell.Kill()
	a.run.Kill()
	a.shell.Reset()
	a.run.Reset()
	return nil, nil
}

const tmplMain = `package main

import "std/fmt"

func main() {
	name := "gocpy"
	fmt.Println(f"Привет, {name}!")
}
`

func (a *App) apiNew(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	p := expandHome(strings.TrimSpace(req.Path))
	if !filepath.IsAbs(p) {
		return nil, errors.New("укажите абсолютный путь для нового проекта")
	}
	if err := os.MkdirAll(p, 0o755); err != nil {
		return nil, err
	}
	name := filepath.Base(p)
	mod := strings.Map(func(r rune) rune {
		if r == ' ' {
			return '-'
		}
		return r
	}, strings.ToLower(name))
	files := map[string]string{
		"main.gocpy": tmplMain,
		"gocpy.yml":  fmt.Sprintf("module: example.com/%s\nversion: 0.1.0\nbuild:\n  opt: 2\n  gc: boehm\n", mod),
		".gitignore": "/bin/\n/" + name + "\n*.o\n",
	}
	for f, c := range files {
		fp := filepath.Join(p, f)
		if _, err := os.Stat(fp); err == nil {
			continue
		}
		if err := os.WriteFile(fp, []byte(c), 0o644); err != nil {
			return nil, err
		}
	}
	if err := a.OpenProject(p); err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.state.LastFile[p] = "main.gocpy"
	a.mu.Unlock()
	return a.apiState(w, r)
}

// apiSaveAs copies the whole project to a new location and opens the copy.
func (a *App) apiSaveAs(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	src := a.Project()
	if src == "" {
		return nil, errors.New("проект не открыт")
	}
	dst := filepath.Clean(expandHome(strings.TrimSpace(req.Path)))
	if !filepath.IsAbs(dst) {
		return nil, errors.New("укажите абсолютный путь")
	}
	if dst == src || strings.HasPrefix(dst, src+string(filepath.Separator)) {
		return nil, errors.New("нельзя сохранить проект внутрь самого себя")
	}
	if ents, err := os.ReadDir(dst); err == nil && len(ents) > 0 {
		return nil, fmt.Errorf("папка %s уже существует и не пуста", dst)
	}
	if err := copyTree(src, dst); err != nil {
		return nil, err
	}
	a.mu.Lock()
	last := a.state.LastFile[src]
	a.state.LastFile[dst] = last
	a.mu.Unlock()
	if err := a.OpenProject(dst); err != nil {
		return nil, err
	}
	return a.apiState(w, r)
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case info.Mode()&os.ModeSymlink != 0:
			l, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(l, target)
		case info.Mode().IsRegular():
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
		return nil
	})
}

// apiPick shows a native macOS dialog (AppleScript) and returns the chosen path.
// kind: "folder" (existing folder) or "new" (name for a new folder).
func (a *App) apiPick(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Kind, Prompt, Name string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if runtime.GOOS != "darwin" {
		return map[string]any{"unsupported": true}, nil
	}
	esc := func(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) }
	prompt := req.Prompt
	if prompt == "" {
		prompt = "Выберите папку проекта"
	}
	var script []string
	if req.Kind == "new" {
		name := req.Name
		if name == "" {
			name = "my-gocpy-project"
		}
		script = []string{"activate", fmt.Sprintf(`set f to choose file name with prompt "%s" default name "%s"`, esc(prompt), esc(name)), "POSIX path of f"}
	} else {
		script = []string{"activate", fmt.Sprintf(`set f to choose folder with prompt "%s"`, esc(prompt)), "POSIX path of f"}
	}
	args := []string{}
	for _, l := range script {
		args = append(args, "-e", l)
	}
	out, err := exec.Command("osascript", args...).Output()
	if err != nil {
		// user pressed Cancel (error -128)
		return map[string]any{"cancelled": true}, nil
	}
	p := strings.TrimRight(strings.TrimSpace(string(out)), "/")
	if p == "" {
		p = "/"
	}
	return map[string]any{"path": p}, nil
}

// ------------------------------------------------------------------ files

type Node struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Dir      bool    `json:"dir"`
	Children []*Node `json:"children,omitempty"`
}

var alwaysHidden = map[string]bool{".DS_Store": true}

func (a *App) apiTree(w http.ResponseWriter, r *http.Request) (any, error) {
	root := a.Project()
	if root == "" {
		return nil, errors.New("проект не открыт")
	}
	showHidden := a.Settings().ShowHidden
	count := 0
	var walk func(abs, rel string, depth int) []*Node
	walk = func(abs, rel string, depth int) []*Node {
		ents, err := os.ReadDir(abs)
		if err != nil {
			return nil
		}
		var nodes []*Node
		for _, e := range ents {
			name := e.Name()
			if alwaysHidden[name] || (!showHidden && strings.HasPrefix(name, ".") && name != ".gitignore") {
				continue
			}
			if count > 20000 {
				break
			}
			count++
			n := &Node{Name: name, Path: strings.TrimPrefix(rel+"/"+name, "/")}
			isDir := e.IsDir()
			if e.Type()&os.ModeSymlink != 0 {
				if st, err := os.Stat(filepath.Join(abs, name)); err == nil && st.IsDir() {
					isDir = true
				}
			}
			n.Dir = isDir
			if isDir && depth < 24 && name != ".git" && name != "node_modules" {
				n.Children = walk(filepath.Join(abs, name), n.Path, depth+1)
				if n.Children == nil {
					n.Children = []*Node{}
				}
			} else if isDir {
				n.Children = []*Node{}
			}
			nodes = append(nodes, n)
		}
		sort.SliceStable(nodes, func(i, j int) bool {
			if nodes[i].Dir != nodes[j].Dir {
				return nodes[i].Dir
			}
			return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
		})
		return nodes
	}
	return map[string]any{"root": root, "name": filepath.Base(root), "children": walk(root, "", 0)}, nil
}

func (a *App) apiFile(w http.ResponseWriter, r *http.Request) (any, error) {
	switch r.Method {
	case http.MethodGet:
		p, err := a.resolve(r.URL.Query().Get("path"))
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if st.IsDir() {
			return nil, errors.New("это папка")
		}
		if st.Size() > 8<<20 {
			return nil, errors.New("файл слишком большой для редактора (> 8 МБ)")
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		binary := false
		for i, c := range b {
			if i > 8000 {
				break
			}
			if c == 0 {
				binary = true
				break
			}
		}
		if binary {
			return map[string]any{"binary": true, "size": st.Size()}, nil
		}
		return map[string]any{"content": string(b), "mtime": st.ModTime().UnixMilli()}, nil
	case http.MethodPut, http.MethodPost:
		var req struct {
			Path    string
			Content string
		}
		if err := decode(r, &req); err != nil {
			return nil, err
		}
		p, err := a.resolve(req.Path)
		if err != nil {
			return nil, err
		}
		mode := os.FileMode(0o644)
		if st, err := os.Stat(p); err == nil {
			mode = st.Mode().Perm()
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, err
		}
		tmp := p + ".gocpy-ide-tmp"
		if err := os.WriteFile(tmp, []byte(req.Content), mode); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, p); err != nil {
			os.Remove(tmp)
			return nil, err
		}
		st, _ := os.Stat(p)
		return map[string]any{"ok": true, "mtime": st.ModTime().UnixMilli()}, nil
	}
	return nil, errors.New("method not allowed")
}

func validName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return fmt.Errorf("недопустимое имя %q", name)
	}
	return nil
}

func (a *App) apiCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct {
		Parent string
		Name   string
		Dir    bool
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	// allow nested names like "pkg/util.gocpy"
	parts := strings.Split(strings.Trim(req.Name, "/"), "/")
	for _, part := range parts {
		if err := validName(part); err != nil {
			return nil, err
		}
	}
	rel := strings.Trim(req.Parent+"/"+strings.Join(parts, "/"), "/")
	p, err := a.resolve(rel)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(p); err == nil {
		return nil, fmt.Errorf("%s уже существует", rel)
	}
	if req.Dir {
		err = os.MkdirAll(p, 0o755)
	} else {
		if err = os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
			var f *os.File
			f, err = os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
			if err == nil {
				if strings.HasSuffix(p, ".gocpy") {
					pkg := "main"
					if d := filepath.Base(filepath.Dir(p)); filepath.Dir(p) != a.Project() {
						pkg = strings.ToLower(strings.ReplaceAll(d, "-", "_"))
					}
					fmt.Fprintf(f, "package %s\n", pkg)
				}
				err = f.Close()
			}
		}
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": rel}, nil
}

func (a *App) apiRename(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path, Name string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if err := validName(req.Name); err != nil {
		return nil, err
	}
	p, err := a.resolve(req.Path)
	if err != nil {
		return nil, err
	}
	if p == a.Project() {
		return nil, errors.New("нельзя переименовать корень проекта")
	}
	np := filepath.Join(filepath.Dir(p), req.Name)
	if _, err := os.Lstat(np); err == nil {
		return nil, fmt.Errorf("%s уже существует", req.Name)
	}
	if err := os.Rename(p, np); err != nil {
		return nil, err
	}
	rel, _ := filepath.Rel(a.Project(), np)
	return map[string]any{"path": filepath.ToSlash(rel)}, nil
}

func (a *App) apiDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	p, err := a.resolve(req.Path)
	if err != nil {
		return nil, err
	}
	if p == a.Project() {
		return nil, errors.New("нельзя удалить корень проекта")
	}
	// Prefer the macOS Trash so deletion is recoverable.
	if runtime.GOOS == "darwin" {
		script := fmt.Sprintf(`tell application "Finder" to delete (POSIX file "%s" as alias)`, strings.ReplaceAll(p, `"`, `\"`))
		if err := exec.Command("osascript", "-e", script).Run(); err == nil {
			return map[string]any{"trash": true}, nil
		}
	}
	return nil, os.RemoveAll(p)
}

func (a *App) apiReveal(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ Path string }
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	p, err := a.resolve(req.Path)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "darwin" {
		return nil, exec.Command("open", "-R", p).Start()
	}
	return nil, exec.Command("xdg-open", filepath.Dir(p)).Start()
}

// ------------------------------------------------------------------ run

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if strings.IndexFunc(s, func(r rune) bool {
		return !(r == '/' || r == '.' || r == '-' || r == '_' || r == '+' || r == ':' || r == '=' || r == ',' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (a *App) apiRun(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct{ File string }
	_ = decode(r, &req)
	root := a.Project()
	if root == "" {
		return nil, errors.New("проект не открыт")
	}
	s := a.Settings()
	file, dir := "", root
	if req.File != "" {
		if p, err := a.resolve(req.File); err == nil {
			file, dir = p, filepath.Dir(p)
		}
	}
	gocpy := s.GocpyPath
	if gocpy == "" {
		gocpy = "gocpy"
	}
	cmdline := s.RunCommand
	if strings.TrimSpace(cmdline) == "" {
		cmdline = defaultSettings().RunCommand
	}
	rep := strings.NewReplacer(
		"{gocpy}", shellQuote(expandHome(gocpy)),
		"{project}", shellQuote(root),
		"{file}", shellQuote(file),
		"{dir}", shellQuote(dir),
		"{name}", shellQuote(filepath.Base(root)),
	)
	cmdline = rep.Replace(cmdline)
	if err := a.run.StartCommand(cmdline, root, s.ClearOnRun); err != nil {
		return nil, err
	}
	return map[string]any{"command": cmdline}, nil
}

func (a *App) apiStop(w http.ResponseWriter, r *http.Request) (any, error) {
	a.run.Interrupt()
	return nil, nil
}

func (a *App) userShell() string {
	if s := a.Settings().Shell; s != "" {
		return expandHome(s)
	}
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	if runtime.GOOS == "darwin" {
		return "/bin/zsh"
	}
	return "/bin/bash"
}

func nowMillis() int64 { return time.Now().UnixMilli() }
