package app

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

func LoadBackendDotEnv() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	executablePath, executableErr := os.Executable()
	if executableErr != nil {
		executablePath = ""
	}

	return loadFirstExistingEnvFile(backendEnvCandidates(cwd, executablePath))
}

func backendEnvCandidates(cwd, executablePath string) []string {
	candidates := make([]string, 0, 3)

	if filepath.Base(filepath.Clean(cwd)) == "backend" {
		candidates = append(candidates, filepath.Join(cwd, ".env"))
	} else {
		candidates = append(candidates, filepath.Join(cwd, "backend", ".env"))
	}

	if executablePath != "" {
		executableDir := filepath.Dir(executablePath)
		candidates = append(candidates, filepath.Clean(filepath.Join(executableDir, "..", ".env")))
	}

	return uniquePaths(candidates)
}

func loadFirstExistingEnvFile(candidates []string) (string, error) {
	for _, candidate := range candidates {
		fileInfo, err := os.Stat(candidate)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return "", err
		}

		if fileInfo.IsDir() {
			continue
		}

		if err := godotenv.Load(candidate); err != nil {
			return "", err
		}

		return candidate, nil
	}

	return "", nil
}

func uniquePaths(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	unique := make([]string, 0, len(values))

	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}

		seen[value] = struct{}{}
		unique = append(unique, value)
	}

	return unique
}
