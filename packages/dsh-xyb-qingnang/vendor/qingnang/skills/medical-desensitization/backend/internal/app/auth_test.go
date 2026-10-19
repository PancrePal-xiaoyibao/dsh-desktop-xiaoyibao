package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

func TestAuthRegisterLoginAndHistory(t *testing.T) {
	backend := newBackendHTTPServer(t, testConfig())
	defer backend.Close()

	registerBody := bytes.NewBufferString(`{"username":"demo@example.com","displayName":"演示用户","password":"password123"}`)
	registerRequest, err := http.NewRequest(http.MethodPost, backend.URL+"/api/auth/register", registerBody)
	if err != nil {
		t.Fatalf("create register request failed: %v", err)
	}
	registerRequest.Header.Set("Content-Type", "application/json")
	registerRequest.Header.Set("Origin", "http://frontend.test")

	registerResponse, err := http.DefaultClient.Do(registerRequest)
	if err != nil {
		t.Fatalf("register request failed: %v", err)
	}
	if registerResponse.StatusCode != http.StatusCreated {
		t.Fatalf("unexpected register status: %d", registerResponse.StatusCode)
	}

	var authPayload authResponse
	if err := json.NewDecoder(registerResponse.Body).Decode(&authPayload); err != nil {
		t.Fatalf("decode auth response failed: %v", err)
	}
	if authPayload.Token == "" || authPayload.User.ID == "" {
		t.Fatalf("missing auth response fields: %#v", authPayload)
	}

	historyBody := bytes.NewBufferString(`{"sessions":[{"id":"s1","title":"测试对话","messages":[{"role":"user","content":"已脱敏内容","id":"m1","createdAt":1}],"createdAt":1,"updatedAt":1}],"activeSessionId":"s1"}`)
	historyRequest, err := http.NewRequest(http.MethodPut, backend.URL+"/api/history", historyBody)
	if err != nil {
		t.Fatalf("create history request failed: %v", err)
	}
	historyRequest.Header.Set("Content-Type", "application/json")
	historyRequest.Header.Set("Origin", "http://frontend.test")
	historyRequest.Header.Set("Authorization", "Bearer "+authPayload.Token)

	historyResponse, err := http.DefaultClient.Do(historyRequest)
	if err != nil {
		t.Fatalf("history request failed: %v", err)
	}
	if historyResponse.StatusCode != http.StatusOK {
		t.Fatalf("unexpected history save status: %d", historyResponse.StatusCode)
	}

	loginBody := bytes.NewBufferString(`{"username":"demo@example.com","password":"password123"}`)
	loginRequest, err := http.NewRequest(http.MethodPost, backend.URL+"/api/auth/login", loginBody)
	if err != nil {
		t.Fatalf("create login request failed: %v", err)
	}
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Origin", "http://frontend.test")

	loginResponse, err := http.DefaultClient.Do(loginRequest)
	if err != nil {
		t.Fatalf("login request failed: %v", err)
	}
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("unexpected login status: %d", loginResponse.StatusCode)
	}

	var loginPayload authResponse
	if err := json.NewDecoder(loginResponse.Body).Decode(&loginPayload); err != nil {
		t.Fatalf("decode login response failed: %v", err)
	}

	getHistoryRequest, err := http.NewRequest(http.MethodGet, backend.URL+"/api/history", nil)
	if err != nil {
		t.Fatalf("create get history request failed: %v", err)
	}
	getHistoryRequest.Header.Set("Origin", "http://frontend.test")
	getHistoryRequest.Header.Set("Authorization", "Bearer "+loginPayload.Token)

	getHistoryResponse, err := http.DefaultClient.Do(getHistoryRequest)
	if err != nil {
		t.Fatalf("get history request failed: %v", err)
	}
	if getHistoryResponse.StatusCode != http.StatusOK {
		t.Fatalf("unexpected get history status: %d", getHistoryResponse.StatusCode)
	}

	var history historyState
	if err := json.NewDecoder(getHistoryResponse.Body).Decode(&history); err != nil {
		t.Fatalf("decode history failed: %v", err)
	}
	if len(history.Sessions) != 1 || history.Sessions[0].Title != "测试对话" {
		t.Fatalf("history not preserved: %#v", history)
	}
}
