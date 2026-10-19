package app

import (
	"bytes"
	"strings"
	"testing"
)

func TestNormalizeLogLevel(t *testing.T) {
	if got := normalizeLogLevel("DEBUG"); got != "debug" {
		t.Fatalf("unexpected normalized level: got %q want %q", got, "debug")
	}

	if got := normalizeLogLevel("invalid"); got != "log" {
		t.Fatalf("unexpected fallback level: got %q want %q", got, "log")
	}
}

func TestLoggerSuppressesDebugAtLogLevel(t *testing.T) {
	var buffer bytes.Buffer
	logger := NewLogger("log", &buffer)

	logger.Logf("hello %s", "world")
	logger.Debugf("hidden")
	logger.Errorf("boom")

	output := buffer.String()
	if !strings.Contains(output, "[LOG] hello world") {
		t.Fatalf("missing log output: %s", output)
	}
	if !strings.Contains(output, "[ERROR] boom") {
		t.Fatalf("missing error output: %s", output)
	}
	if strings.Contains(output, "[DEBUG] hidden") {
		t.Fatalf("debug output should be suppressed: %s", output)
	}
}

func TestLoggerShowsDebugAtDebugLevel(t *testing.T) {
	var buffer bytes.Buffer
	logger := NewLogger("debug", &buffer)

	logger.Debugf("details")

	if !strings.Contains(buffer.String(), "[DEBUG] details") {
		t.Fatalf("missing debug output: %s", buffer.String())
	}
}
