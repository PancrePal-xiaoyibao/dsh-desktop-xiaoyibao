package app

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type logLevel int

type contextKey string

const (
	logLevelLog logLevel = iota
	logLevelDebug

	requestIDContextKey contextKey = "request_id"
)

type Logger struct {
	base  *log.Logger
	level logLevel
	mu    sync.RWMutex
}

var (
	defaultLogger  = NewLogger("log", os.Stdout)
	requestCounter uint64
)

func NewLogger(level string, writer io.Writer) *Logger {
	if writer == nil {
		writer = os.Stdout
	}

	return &Logger{
		base:  log.New(writer, "", log.LstdFlags|log.Lmicroseconds),
		level: parseLogLevel(level),
	}
}

func ConfigureLogger(level string) {
	defaultLogger.SetLevel(level)
}

func Logf(format string, args ...any) {
	defaultLogger.Logf(format, args...)
}

func Debugf(format string, args ...any) {
	defaultLogger.Debugf(format, args...)
}

func Errorf(format string, args ...any) {
	defaultLogger.Errorf(format, args...)
}

func ContextLogf(ctx context.Context, format string, args ...any) {
	defaultLogger.Logf("%s", withRequestContext(ctx, format, args...))
}

func ContextDebugf(ctx context.Context, format string, args ...any) {
	defaultLogger.Debugf("%s", withRequestContext(ctx, format, args...))
}

func ContextErrorf(ctx context.Context, format string, args ...any) {
	defaultLogger.Errorf("%s", withRequestContext(ctx, format, args...))
}

func (l *Logger) SetLevel(level string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.level = parseLogLevel(level)
}

func (l *Logger) Logf(format string, args ...any) {
	l.print(logLevelLog, "LOG", format, args...)
}

func (l *Logger) Debugf(format string, args ...any) {
	l.print(logLevelDebug, "DEBUG", format, args...)
}

func (l *Logger) Errorf(format string, args ...any) {
	l.print(logLevelLog, "ERROR", format, args...)
}

func (l *Logger) print(requiredLevel logLevel, label, format string, args ...any) {
	l.mu.RLock()
	currentLevel := l.level
	l.mu.RUnlock()

	if currentLevel < requiredLevel {
		return
	}

	l.base.Printf("[%s] %s", label, fmt.Sprintf(format, args...))
}

func parseLogLevel(value string) logLevel {
	if normalizeLogLevel(value) == "debug" {
		return logLevelDebug
	}

	return logLevelLog
}

func withRequestContext(ctx context.Context, format string, args ...any) string {
	message := fmt.Sprintf(format, args...)
	requestID := requestIDFromContext(ctx)
	if requestID == "" {
		return message
	}

	return fmt.Sprintf("req_id=%s %s", requestID, message)
}

func ensureRequestContext(r *http.Request) *http.Request {
	requestID := strings.TrimSpace(r.Header.Get("X-Request-Id"))
	if requestID == "" {
		requestID = nextRequestID()
	}

	return r.WithContext(context.WithValue(r.Context(), requestIDContextKey, requestID))
}

func requestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}

	requestID, _ := ctx.Value(requestIDContextKey).(string)
	return requestID
}

func nextRequestID() string {
	sequence := atomic.AddUint64(&requestCounter, 1)
	return fmt.Sprintf("req-%d-%d", time.Now().UnixNano(), sequence)
}
