package app

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBackendEnvCandidates_FromRepoRoot(t *testing.T) {
	cwd := filepath.Join(string(filepath.Separator), "workspace", "repo")
	executablePath := filepath.Join(cwd, "backend", "bin", "server")

	got := backendEnvCandidates(cwd, executablePath)
	want := []string{
		filepath.Join(cwd, "backend", ".env"),
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("backendEnvCandidates mismatch:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestBackendEnvCandidates_FromBackendDir(t *testing.T) {
	cwd := filepath.Join(string(filepath.Separator), "workspace", "repo", "backend")
	executablePath := filepath.Join(cwd, "bin", "server")

	got := backendEnvCandidates(cwd, executablePath)
	want := []string{
		filepath.Join(cwd, ".env"),
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("backendEnvCandidates mismatch:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestLoadFirstExistingEnvFile_LoadsWithoutOverridingExistingEnv(t *testing.T) {
	tempDir := t.TempDir()
	envFile := filepath.Join(tempDir, ".env")
	content := "BACKEND_PORT=9090\nCHAT_API_KEY=from-file\n"

	if err := os.WriteFile(envFile, []byte(content), 0o600); err != nil {
		t.Fatalf("write env file failed: %v", err)
	}

	t.Setenv("CHAT_API_KEY", "from-env")
	if err := os.Unsetenv("BACKEND_PORT"); err != nil {
		t.Fatalf("unset BACKEND_PORT failed: %v", err)
	}

	loadedPath, err := loadFirstExistingEnvFile([]string{envFile})
	if err != nil {
		t.Fatalf("loadFirstExistingEnvFile returned error: %v", err)
	}

	if loadedPath != envFile {
		t.Fatalf("unexpected loaded path: got %q want %q", loadedPath, envFile)
	}

	if got := os.Getenv("BACKEND_PORT"); got != "9090" {
		t.Fatalf("BACKEND_PORT mismatch: got %q want %q", got, "9090")
	}

	if got := os.Getenv("CHAT_API_KEY"); got != "from-env" {
		t.Fatalf("CHAT_API_KEY should not be overridden: got %q want %q", got, "from-env")
	}
}
