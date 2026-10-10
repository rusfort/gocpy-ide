// Command gocpy-ide is a lightweight IDE for the Gocpy language.
//
// It is a single self-contained binary: a local HTTP server (127.0.0.1 only,
// protected by a random token) with an embedded web UI (CodeMirror 6 +
// xterm.js) that is opened in a chromeless app window.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

//go:embed web/dist
var webFS embed.FS

var version = "0.1.0"

func main() {
	port := flag.Int("port", 0, "port to listen on (0 = random)")
	noOpen := flag.Bool("no-open", false, "do not open an app window")
	project := flag.String("project", "", "project directory to open")
	token := flag.String("token", "", "access token (default: random)")
	keepAlive := flag.Bool("keep-alive", false, "do not exit when the window is closed")
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println("gocpy-ide", version)
		return
	}
	if flag.NArg() > 0 && *project == "" {
		*project = flag.Arg(0)
	}

	tok := *token
	if tok == "" {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		tok = hex.EncodeToString(b)
	}

	app, err := NewApp(tok)
	if err != nil {
		log.Fatal(err)
	}
	if *project != "" {
		abs, _ := filepath.Abs(*project)
		if err := app.OpenProject(abs); err != nil {
			log.Printf("open project: %v", err)
		}
	}

	dist, _ := fs.Sub(webFS, "web/dist")
	mux := http.NewServeMux()
	app.Routes(mux)
	mux.Handle("/", http.FileServer(http.FS(dist)))

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	url := fmt.Sprintf("http://%s/?token=%s", ln.Addr().String(), tok)
	fmt.Println("Gocpy IDE:", url)

	srv := &http.Server{Handler: securityHeaders(mux)}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !*keepAlive {
		app.OnIdle = func() { stop() }
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	if !*noOpen {
		go func() {
			time.Sleep(150 * time.Millisecond)
			if err := openWindow(url, app.ConfigDir()); err != nil {
				log.Printf("open window: %v (open %s manually)", err, url)
			}
		}()
	}
	// If no window ever connects, do not linger forever.
	if !*keepAlive && !*noOpen {
		go func() {
			time.Sleep(90 * time.Second)
			if !app.EverConnected() {
				stop()
			}
		}()
	}
	<-ctx.Done()
	app.Shutdown()
	sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}
