package main

import (
	"os/exec"
	"path/filepath"
)

// openWindow opens the UI in a chromeless app window when a Chromium-based
// browser is installed (separate profile, so closing the window quits the IDE),
// otherwise in the default browser.
func openWindow(url, cfgDir string) error {
	for _, app := range []string{"Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Vivaldi", "Yandex"} {
		if exec.Command("open", "-Ra", app).Run() != nil {
			continue
		}
		profile := filepath.Join(cfgDir, "window-profile")
		return exec.Command("open", "-na", app, "--args",
			"--app="+url,
			"--user-data-dir="+profile,
			"--no-first-run",
			"--no-default-browser-check",
			"--window-size=1440,900",
		).Start()
	}
	return exec.Command("open", url).Start()
}
