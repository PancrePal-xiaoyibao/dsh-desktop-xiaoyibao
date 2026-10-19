package app

import (
	"bufio"
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	config     Config
	httpClient *http.Client
	upgrader   websocket.Upgrader
	authStore  *authStore
}

func NewServer(config Config) *Server {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}
	configureChatDialFallback(transport, config)

	return &Server{
		config: config,
		httpClient: &http.Client{
			Timeout:   0,
			Transport: transport,
		},
		authStore: newAuthStore(config.DataDir),
		upgrader: websocket.Upgrader{
			EnableCompression: false,
			CheckOrigin: func(r *http.Request) bool {
				return isOriginAllowed(r.Header.Get("Origin"), config.CORSAllowedOrigins)
			},
		},
	}
}

func configureChatDialFallback(transport *http.Transport, config Config) {
	if transport == nil || strings.TrimSpace(config.ChatAPIResolvedIP) == "" || strings.TrimSpace(config.ChatAPIURL) == "" {
		return
	}

	chatURL, err := url.Parse(config.ChatAPIURL)
	if err != nil || chatURL.Hostname() == "" {
		return
	}

	chatHost := chatURL.Hostname()
	chatPort := chatURL.Port()
	if chatPort == "" {
		if strings.EqualFold(chatURL.Scheme, "http") {
			chatPort = "80"
		} else {
			chatPort = "443"
		}
	}

	baseDialer := &net.Dialer{Timeout: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != net.JoinHostPort(chatHost, chatPort) {
			return baseDialer.DialContext(ctx, network, addr)
		}

		conn, err := baseDialer.DialContext(ctx, network, addr)
		if err == nil {
			return conn, nil
		}

		if !strings.Contains(err.Error(), "no such host") {
			return nil, err
		}

		return baseDialer.DialContext(ctx, network, net.JoinHostPort(config.ChatAPIResolvedIP, chatPort))
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.withLogging("healthz", s.handleHealthz))
	mux.HandleFunc("/api/auth/register", s.withLogging("auth.register", s.withCORS(s.handleAuthRegister)))
	mux.HandleFunc("/api/auth/login", s.withLogging("auth.login", s.withCORS(s.handleAuthLogin)))
	mux.HandleFunc("/api/auth/logout", s.withLogging("auth.logout", s.withCORS(s.handleAuthLogout)))
	mux.HandleFunc("/api/auth/me", s.withLogging("auth.me", s.withCORS(s.handleAuthMe)))
	mux.HandleFunc("/api/history", s.withLogging("history", s.withCORS(s.handleHistory)))
	mux.HandleFunc("/api/chat", s.withLogging("chat", s.withCORS(s.handleChat)))
	mux.HandleFunc("/api/desensitize", s.withLogging("desensitize", s.withCORS(s.handleDesensitize)))
	mux.HandleFunc("/api/tts", s.withLogging("tts", s.withCORS(s.handleTTS)))
	mux.HandleFunc("/api/stt", s.withLogging("stt", s.withCORS(s.handleSTT)))
	mux.HandleFunc("/api/stt/ws", s.handleSTTWebSocket)
	return mux
}

func (s *Server) ListenAndServe() error {
	server := &http.Server{
		Addr:              ":" + s.config.Port,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	Logf("server listening addr=:%s", s.config.Port)
	return server.ListenAndServe()
}

func (s *Server) withLogging(route string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r = ensureRequestContext(r)
		requestID := requestIDFromContext(r.Context())
		w.Header().Set("X-Request-Id", requestID)
		w.Header().Set("X-Content-Type-Options", "nosniff")

		startedAt := time.Now()
		recorder := &responseRecorder{
			ResponseWriter: w,
			statusCode:     http.StatusOK,
		}

		ContextDebugf(
			r.Context(),
			"request.started route=%s method=%s path=%s origin=%q remote=%q user_agent=%q",
			route,
			r.Method,
			r.URL.Path,
			r.Header.Get("Origin"),
			r.RemoteAddr,
			r.UserAgent(),
		)

		next(recorder, r)

		ContextLogf(
			r.Context(),
			"request.completed route=%s method=%s path=%s status=%d duration=%s bytes=%d",
			route,
			r.Method,
			r.URL.Path,
			recorder.statusCode,
			time.Since(startedAt).Round(time.Millisecond),
			recorder.bytesWritten,
		)
	}
}

func (s *Server) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if matched, ok := matchAllowedOrigin(origin, s.config.CORSAllowedOrigins); ok {
			w.Header().Set("Access-Control-Allow-Origin", matched)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "false")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next(w, r)
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"stt":     strings.ToLower(s.config.STTProvider),
		"tts":     strings.ToLower(s.config.TTSProvider),
		"backend": "go",
	})
}

type responseRecorder struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int
}

func (r *responseRecorder) WriteHeader(statusCode int) {
	r.statusCode = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if r.statusCode == 0 {
		r.statusCode = http.StatusOK
	}

	bytesWritten, err := r.ResponseWriter.Write(body)
	r.bytesWritten += bytesWritten
	return bytesWritten, err
}

func (r *responseRecorder) Flush() {
	flusher, ok := r.ResponseWriter.(http.Flusher)
	if ok {
		flusher.Flush()
	}
}

func (r *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}

	return hijacker.Hijack()
}
