package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxTTSTextLength = 2000

var (
	codeFencePattern   = regexp.MustCompile("(?s)```.*?```")
	inlineCodePattern  = regexp.MustCompile("`([^`]*)`")
	imagePattern       = regexp.MustCompile(`!\[[^\]]*]\([^)]*\)`)
	linkPattern        = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	markdownChars      = regexp.MustCompile(`[#*_~>|]`)
	blankLinePattern   = regexp.MustCompile(`\n{3,}`)
	multiSpacePattern  = regexp.MustCompile(`[ \t]{2,}`)
	orderedListPattern = regexp.MustCompile(`\d+[.、]`)
)

type appError struct {
	Status     int
	Message    string
	LogMessage string
}

type cancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel func()
}

func (e *appError) Error() string {
	return e.Message
}

func (r *cancelOnCloseReadCloser) Close() error {
	err := r.ReadCloser.Close()
	if r.cancel != nil {
		r.cancel()
		r.cancel = nil
	}
	return err
}

func newAppError(status int, message string, logMessage ...string) *appError {
	err := &appError{
		Status:  status,
		Message: message,
	}
	if len(logMessage) > 0 {
		err.LogMessage = logMessage[0]
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(ctx context.Context, w http.ResponseWriter, err error) {
	var appErr *appError
	if errors.As(err, &appErr) {
		if appErr.LogMessage != "" {
			ContextErrorf(ctx, "request.failed status=%d message=%q detail=%s", appErr.Status, appErr.Message, appErr.LogMessage)
		} else {
			ContextErrorf(ctx, "request.failed status=%d message=%q", appErr.Status, appErr.Message)
		}
		writeJSON(w, appErr.Status, map[string]string{"error": appErr.Message})
		return
	}

	ContextErrorf(ctx, "request.failed error=%v", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "服务内部错误，请稍后重试"})
}

func cleanTTSText(text string) string {
	cleaned := codeFencePattern.ReplaceAllString(text, " ")
	cleaned = inlineCodePattern.ReplaceAllString(cleaned, "$1")
	cleaned = imagePattern.ReplaceAllString(cleaned, " ")
	cleaned = linkPattern.ReplaceAllString(cleaned, "$1")
	cleaned = markdownChars.ReplaceAllString(cleaned, "")
	cleaned = strings.ReplaceAll(cleaned, "\r\n", "\n")
	cleaned = blankLinePattern.ReplaceAllString(cleaned, "\n\n")
	cleaned = multiSpacePattern.ReplaceAllString(cleaned, " ")
	cleaned = orderedListPattern.ReplaceAllString(cleaned, "")
	return strings.TrimSpace(cleaned)
}

func fetchWithTimeout(ctx context.Context, timeout time.Duration, fn func(context.Context) (*http.Response, error)) (*http.Response, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)

	response, err := fn(requestCtx)
	if err != nil {
		cancel()
		if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			return nil, newAppError(http.StatusGatewayTimeout, "请求上游超时，请稍后重试")
		}
		return nil, err
	}

	if response == nil || response.Body == nil {
		cancel()
		return response, nil
	}

	response.Body = &cancelOnCloseReadCloser{
		ReadCloser: response.Body,
		cancel:     cancel,
	}

	return response, nil
}

func isOriginAllowed(origin string, allowedOrigins []string) bool {
	if origin == "" {
		return true
	}

	for _, allowed := range allowedOrigins {
		if origin == allowed {
			return true
		}
	}

	return false
}

// matchAllowedOrigin 返回白名单中匹配的安全来源字符串，避免将用户输入直接反射到响应头中。
func matchAllowedOrigin(origin string, allowedOrigins []string) (string, bool) {
	if origin == "" {
		return "", false
	}

	for _, allowed := range allowedOrigins {
		if origin == allowed {
			return allowed, true
		}
	}

	return "", false
}

func hostMatchesOrigin(origin, host string) bool {
	if origin == "" || host == "" {
		return true
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}

	return parsed.Host == host
}

func safeReadText(response *http.Response, limit int64) string {
	if response == nil || response.Body == nil {
		return ""
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, limit))
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(body))
}

func logSafeURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	return parsed.String()
}

func gzipBytes(payload []byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(payload); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func gunzipBytes(payload []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func decodeBase64Audio(encoded string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(encoded)
}

func writeUint32BE(buffer []byte, value uint32) {
	binary.BigEndian.PutUint32(buffer, value)
}
