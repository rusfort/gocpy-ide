//go:build !darwin

package main

import "os/exec"

func openWindow(url, cfgDir string) error {
	for _, b := range []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge"} {
		if p, err := exec.LookPath(b); err == nil {
			return exec.Command(p, "--app="+url, "--user-data-dir="+cfgDir+"/window-profile", "--no-first-run").Start()
		}
	}
	return exec.Command("xdg-open", url).Start()
}
