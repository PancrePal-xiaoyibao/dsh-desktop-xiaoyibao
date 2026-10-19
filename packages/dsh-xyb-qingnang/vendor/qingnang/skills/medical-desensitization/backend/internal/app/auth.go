package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	authStateFileName = "auth-state.json"
	sessionTTL        = 30 * 24 * time.Hour
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_\-.@]{3,64}$`)

type authStore struct {
	path string
	mu   sync.Mutex
}

type authState struct {
	Users    map[string]storedUser    `json:"users"`
	Sessions map[string]storedSession `json:"sessions"`
	History  map[string]historyState  `json:"history"`
}

type storedUser struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	PasswordHash string `json:"passwordHash"`
	CreatedAt    int64  `json:"createdAt"`
	LastLoginAt  int64  `json:"lastLoginAt"`
}

type storedSession struct {
	UserID    string `json:"userId"`
	TokenHash string `json:"tokenHash"`
	ExpiresAt int64  `json:"expiresAt"`
	CreatedAt int64  `json:"createdAt"`
}

type historyState struct {
	Sessions        []chatHistorySession `json:"sessions"`
	ActiveSessionID string               `json:"activeSessionId"`
	UpdatedAt       int64                `json:"updatedAt"`
}

type chatHistorySession struct {
	ID        string               `json:"id"`
	Title     string               `json:"title"`
	Messages  []chatHistoryMessage `json:"messages"`
	CreatedAt int64                `json:"createdAt"`
	UpdatedAt int64                `json:"updatedAt"`
}

type chatHistoryMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	ID        string `json:"id"`
	CreatedAt int64  `json:"createdAt"`
}

type authUserResponse struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

type authResponse struct {
	Token string           `json:"token"`
	User  authUserResponse `json:"user"`
}

type authCredentials struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName,omitempty"`
	Password    string `json:"password"`
}

func newAuthStore(dataDir string) *authStore {
	return &authStore{path: filepath.Join(dataDir, authStateFileName)}
}

func (s *Server) handleAuthRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var credentials authCredentials
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&credentials); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求格式不正确"})
		return
	}

	response, err := s.authStore.register(credentials)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	writeJSON(w, http.StatusCreated, response)
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var credentials authCredentials
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&credentials); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求格式不正确"})
		return
	}

	response, err := s.authStore.login(credentials)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	token, ok := bearerToken(r)
	if ok {
		if err := s.authStore.logout(token); err != nil {
			writeError(r.Context(), w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	user, err := s.authenticatedUser(r)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]authUserResponse{"user": user})
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	user, err := s.authenticatedUser(r)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		history, err := s.authStore.history(user.ID)
		if err != nil {
			writeError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, history)
	case http.MethodPut:
		var history historyState
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&history); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求格式不正确"})
			return
		}
		if err := s.authStore.saveHistory(user.ID, history); err != nil {
			writeError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *Server) authenticatedUser(r *http.Request) (authUserResponse, error) {
	token, ok := bearerToken(r)
	if !ok {
		return authUserResponse{}, newAppError(http.StatusUnauthorized, "请先登录")
	}

	return s.authStore.userForToken(token)
}

func bearerToken(r *http.Request) (string, bool) {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(strings.ToLower(value), "bearer ") {
		return "", false
	}
	token := strings.TrimSpace(value[len("Bearer "):])
	return token, token != ""
}

func (store *authStore) register(credentials authCredentials) (authResponse, error) {
	username := normalizeUsername(credentials.Username)
	if !usernamePattern.MatchString(username) {
		return authResponse{}, newAppError(http.StatusBadRequest, "用户名需要 3-64 位，只能包含字母、数字、下划线、点、横线或邮箱符号")
	}
	if len(credentials.Password) < 8 {
		return authResponse{}, newAppError(http.StatusBadRequest, "密码至少需要 8 位")
	}

	store.mu.Lock()
	defer store.mu.Unlock()

	state, err := store.loadLocked()
	if err != nil {
		return authResponse{}, err
	}
	if _, exists := state.Users[username]; exists {
		return authResponse{}, newAppError(http.StatusConflict, "这个用户名已经注册")
	}

	now := time.Now().UnixMilli()
	passwordDigest, err := hashPassword(credentials.Password)
	if err != nil {
		return authResponse{}, err
	}
	user := storedUser{
		ID:           randomToken(18),
		Username:     username,
		DisplayName:  displayName(credentials.DisplayName, username),
		PasswordHash: passwordDigest,
		CreatedAt:    now,
		LastLoginAt:  now,
	}
	state.Users[username] = user

	token, session := newStoredSession(user.ID)
	state.Sessions[tokenHash(token)] = session
	state.History[user.ID] = historyState{Sessions: []chatHistorySession{}, UpdatedAt: now}

	if err := store.saveLocked(state); err != nil {
		return authResponse{}, err
	}

	return authResponse{Token: token, User: user.response()}, nil
}

func (store *authStore) login(credentials authCredentials) (authResponse, error) {
	username := normalizeUsername(credentials.Username)

	store.mu.Lock()
	defer store.mu.Unlock()

	state, err := store.loadLocked()
	if err != nil {
		return authResponse{}, err
	}
	user, exists := state.Users[username]
	if !exists || !verifyPassword(user, credentials.Password) {
		return authResponse{}, newAppError(http.StatusUnauthorized, "用户名或密码不正确")
	}

	now := time.Now().UnixMilli()
	user.LastLoginAt = now
	state.Users[username] = user
	token, session := newStoredSession(user.ID)
	state.Sessions[tokenHash(token)] = session
	pruneExpiredSessions(state)

	if err := store.saveLocked(state); err != nil {
		return authResponse{}, err
	}

	return authResponse{Token: token, User: user.response()}, nil
}

func (store *authStore) logout(token string) error {
	store.mu.Lock()
	defer store.mu.Unlock()

	state, err := store.loadLocked()
	if err != nil {
		return err
	}
	delete(state.Sessions, tokenHash(token))
	return store.saveLocked(state)
}

func (store *authStore) userForToken(token string) (authUserResponse, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	state, err := store.loadLocked()
	if err != nil {
		return authUserResponse{}, err
	}
	session, exists := state.Sessions[tokenHash(token)]
	if !exists || session.ExpiresAt < time.Now().UnixMilli() {
		return authUserResponse{}, newAppError(http.StatusUnauthorized, "登录已过期，请重新登录")
	}
	for _, user := range state.Users {
		if user.ID == session.UserID {
			return user.response(), nil
		}
	}

	return authUserResponse{}, newAppError(http.StatusUnauthorized, "登录已过期，请重新登录")
}

func (store *authStore) history(userID string) (historyState, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	state, err := store.loadLocked()
	if err != nil {
		return historyState{}, err
	}
	history := state.History[userID]
	if history.Sessions == nil {
		history.Sessions = []chatHistorySession{}
	}
	return history, nil
}

func (store *authStore) saveHistory(userID string, history historyState) error {
	store.mu.Lock()
	defer store.mu.Unlock()

	state, err := store.loadLocked()
	if err != nil {
		return err
	}
	history.UpdatedAt = time.Now().UnixMilli()
	if history.Sessions == nil {
		history.Sessions = []chatHistorySession{}
	}
	state.History[userID] = history
	return store.saveLocked(state)
}

func (store *authStore) loadLocked() (authState, error) {
	state := authState{
		Users:    map[string]storedUser{},
		Sessions: map[string]storedSession{},
		History:  map[string]historyState{},
	}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return state, nil
		}
		return state, newAppError(http.StatusInternalServerError, "读取账号数据失败", err.Error())
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return state, nil
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, newAppError(http.StatusInternalServerError, "账号数据损坏", err.Error())
	}
	if state.Users == nil {
		state.Users = map[string]storedUser{}
	}
	if state.Sessions == nil {
		state.Sessions = map[string]storedSession{}
	}
	if state.History == nil {
		state.History = map[string]historyState{}
	}
	return state, nil
}

func (store *authStore) saveLocked(state authState) error {
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		return newAppError(http.StatusInternalServerError, "创建账号数据目录失败", err.Error())
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return newAppError(http.StatusInternalServerError, "保存账号数据失败", err.Error())
	}
	if err := os.WriteFile(store.path, raw, 0o600); err != nil {
		return newAppError(http.StatusInternalServerError, "保存账号数据失败", err.Error())
	}
	return nil
}

func (user storedUser) response() authUserResponse {
	return authUserResponse{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
	}
}

func newStoredSession(userID string) (string, storedSession) {
	now := time.Now()
	token := randomToken(32)
	return token, storedSession{
		UserID:    userID,
		TokenHash: tokenHash(token),
		ExpiresAt: now.Add(sessionTTL).UnixMilli(),
		CreatedAt: now.UnixMilli(),
	}
}

func pruneExpiredSessions(state authState) {
	now := time.Now().UnixMilli()
	for key, session := range state.Sessions {
		if session.ExpiresAt < now {
			delete(state.Sessions, key)
		}
	}
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func displayName(value string, username string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed != "" {
		return trimmed
	}
	return username
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", newAppError(http.StatusInternalServerError, "生成密码哈希失败", err.Error())
	}
	return string(hash), nil
}

func verifyPassword(user storedUser, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) == nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomToken(byteCount int) string {
	raw := make([]byte, byteCount)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
