package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHandleChat_ProxiesSSE(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertHeader(t, r.Header, "Authorization", "Bearer chat-secret")
		assertHeader(t, r.Header, "Content-Type", "application/json")
		assertHeader(t, r.Header, "Accept", "text/event-stream")

		var payload chatRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request failed: %v", err)
		}

		if len(payload.Messages) != 1 || payload.Messages[0]["content"] != "你好" {
			t.Fatalf("unexpected messages payload: %#v", payload.Messages)
		}
		if payload.Stream == nil || !*payload.Stream {
			t.Fatalf("unexpected stream flag: %#v", payload.Stream)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"世\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		time.Sleep(50 * time.Millisecond)
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"界\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer upstream.Close()

	config := testConfig()
	config.ChatAPIURL = upstream.URL

	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	requestBody := strings.NewReader(`{"messages":[{"role":"user","content":"你好"}],"stream":true}`)
	request, err := http.NewRequest(http.MethodPost, backend.URL+"/api/chat", requestBody)
	if err != nil {
		t.Fatalf("create request failed: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://frontend.test")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}
	assertHeader(t, response.Header, "Access-Control-Allow-Origin", "http://frontend.test")
	assertHeader(t, response.Header, "Content-Type", "text/event-stream; charset=utf-8")
	assertHeader(t, response.Header, "Cache-Control", "no-cache, no-transform")
	assertHeader(t, response.Header, "X-Accel-Buffering", "no")

	body := mustReadBody(t, response)
	if !strings.Contains(body, "\"世\"") || !strings.Contains(body, "\"界\"") {
		t.Fatalf("unexpected response body: %s", body)
	}
}

func TestHandleChat_FastGPT_UsesSessionContext(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertHeader(t, r.Header, "Authorization", "Bearer chat-secret")
		assertHeader(t, r.Header, "Accept", "text/event-stream")

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request failed: %v", err)
		}

		if got := payload["chatId"]; got != "session-123" {
			t.Fatalf("unexpected chatId: %#v", got)
		}
		if got := payload["detail"]; got != true {
			t.Fatalf("unexpected detail flag: %#v", got)
		}
		variables, ok := payload["variables"].(map[string]any)
		if !ok || variables["uid"] != "user-456" {
			t.Fatalf("unexpected variables payload: %#v", payload["variables"])
		}

		messages, ok := payload["messages"].([]any)
		if !ok || len(messages) != 1 {
			t.Fatalf("unexpected messages payload: %#v", payload["messages"])
		}
		lastMessage, ok := messages[0].(map[string]any)
		if !ok || lastMessage["content"] != "第二句" {
			t.Fatalf("unexpected last message: %#v", messages[0])
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: answer\ndata: {\"choices\":[{\"delta\":{\"content\":\"FastGPT\"}}]}\n\n")
	}))
	defer upstream.Close()

	config := testConfig()
	config.ChatProvider = "fastgpt"
	config.ChatAPIURL = upstream.URL
	config.FastGPTStreamDetail = false

	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	requestBody := strings.NewReader(`{"messages":[{"role":"user","content":"第一句"},{"role":"user","content":"第二句"}],"stream":true,"chatId":"session-123","detail":true,"variables":{"uid":"user-456"}}`)
	request, err := http.NewRequest(http.MethodPost, backend.URL+"/api/chat", requestBody)
	if err != nil {
		t.Fatalf("create request failed: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://frontend.test")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}

	body := mustReadBody(t, response)
	if !strings.Contains(body, "\"FastGPT\"") {
		t.Fatalf("unexpected response body: %s", body)
	}
}

func TestHandleSTT_Alibaba_ProxiesMultipart(t *testing.T) {
	audio := createTestWAV(16_000, 1, []int16{1, -2, 3, -4})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertHeader(t, r.Header, "Authorization", "Bearer ali-secret")

		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Fatalf("parse multipart form failed: %v", err)
		}
		if got := r.FormValue("model"); got != "paraformer-v1" {
			t.Fatalf("unexpected model: %s", got)
		}

		file, _, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("read form file failed: %v", err)
		}
		defer file.Close()

		fileData, err := io.ReadAll(file)
		if err != nil {
			t.Fatalf("read uploaded file failed: %v", err)
		}
		if !bytes.Equal(fileData, audio) {
			t.Fatal("uploaded audio does not match source audio")
		}

		writeJSON(w, http.StatusOK, map[string]string{"text": "阿里云识别成功"})
	}))
	defer upstream.Close()

	config := testConfig()
	config.STTProvider = "alibaba"
	config.AlibabaBaseURL = upstream.URL

	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	request := createMultipartRequest(t, backend.URL+"/api/stt", "recording.wav", "audio/wav", audio)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", response.StatusCode, mustReadBody(t, response))
	}
	assertHeader(t, response.Header, "Access-Control-Allow-Origin", "http://frontend.test")

	var payload map[string]string
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response failed: %v", err)
	}
	if payload["text"] != "阿里云识别成功" {
		t.Fatalf("unexpected text: %#v", payload)
	}
}

func TestHandleSTT_DoubaoUpload_BridgesWebSocket(t *testing.T) {
	audio := createTestWAV(16_000, 1, []int16{1, 2, 3, 4})
	expectedPCM, err := parseWAVPCM(audio)
	if err != nil {
		t.Fatalf("parse wav failed: %v", err)
	}

	upstreamChecks := make(chan error, 1)
	upstream := newWebSocketServer(t, func(connection *websocket.Conn, _ *http.Request) {
		defer connection.Close()

		_, fullRequestPacket, err := connection.ReadMessage()
		if err != nil {
			upstreamChecks <- fmt.Errorf("read full request failed: %w", err)
			return
		}

		fullRequest := decodeClientJSONPacket(t, fullRequestPacket)
		if got := fullRequest["request"].(map[string]any)["model_name"]; got != "bigmodel" {
			upstreamChecks <- fmt.Errorf("unexpected model_name: %v", got)
			return
		}

		_, audioPacket, err := connection.ReadMessage()
		if err != nil {
			upstreamChecks <- fmt.Errorf("read audio packet failed: %w", err)
			return
		}

		parsedAudioPacket := parseTestClientPacket(t, audioPacket)
		if parsedAudioPacket.MessageType != doubaoMessageTypeAudioOnly {
			upstreamChecks <- fmt.Errorf("unexpected audio message type: %d", parsedAudioPacket.MessageType)
			return
		}
		if parsedAudioPacket.MessageFlags != 0x2 {
			upstreamChecks <- fmt.Errorf("expected final audio packet flag, got %d", parsedAudioPacket.MessageFlags)
			return
		}
		if !bytes.Equal(parsedAudioPacket.Payload, expectedPCM) {
			upstreamChecks <- fmt.Errorf("unexpected PCM payload")
			return
		}

		if err := connection.WriteMessage(websocket.BinaryMessage, createDoubaoServerResponsePacket(t, createTranscriptResponse("豆包上传识别成功"), true)); err != nil {
			upstreamChecks <- fmt.Errorf("write response failed: %w", err)
			return
		}

		upstreamChecks <- nil
	})
	defer upstream.Close()

	config := testConfig()
	config.STTProvider = "doubao"
	config.DoubaoSTTURL = httpToWSURL(upstream.URL)

	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	request := createMultipartRequest(t, backend.URL+"/api/stt", "recording.wav", "audio/wav", audio)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", response.StatusCode, mustReadBody(t, response))
	}

	var payload map[string]string
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response failed: %v", err)
	}
	if payload["text"] != "豆包上传识别成功" {
		t.Fatalf("unexpected text: %#v", payload)
	}

	waitForAsyncError(t, upstreamChecks)
}

func TestHandleTTS_Doubao_ParsesSSEAudio(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertHeader(t, r.Header, "X-Api-App-Id", "doubao-tts-app")
		assertHeader(t, r.Header, "X-Api-Access-Key", "doubao-tts-token")
		assertHeader(t, r.Header, "X-Api-Resource-Id", "seed-tts-2.0")
		assertHeader(t, r.Header, "Accept", "text/event-stream")

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode body failed: %v", err)
		}

		reqParams := payload["req_params"].(map[string]any)
		if got := reqParams["text"]; got != "标题" {
			t.Fatalf("unexpected text after cleanup: %v", got)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Tt-Logid", "tts-log-id")
		_, _ = io.WriteString(w,
			"event: 352\n"+
				"data: {\"data\":\"bXAzLWRhdGE=\"}\n\n"+
				"event: 152\n"+
				"data: {\"status_code\":20000000}\n\n",
		)
	}))
	defer upstream.Close()

	config := testConfig()
	config.TTSProvider = "doubao"
	config.DoubaoTTSURL = upstream.URL

	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	requestBody := strings.NewReader(`{"text":"# 标题"}`)
	request, err := http.NewRequest(http.MethodPost, backend.URL+"/api/tts", requestBody)
	if err != nil {
		t.Fatalf("create request failed: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://frontend.test")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", response.StatusCode, mustReadBody(t, response))
	}
	assertHeader(t, response.Header, "Content-Type", "audio/mpeg")

	if body := mustReadBody(t, response); body != "mp3-data" {
		t.Fatalf("unexpected audio body: %q", body)
	}
}

func TestHandleSTTWebSocket_DoubaoBridge(t *testing.T) {
	audioChunk := []byte{1, 2, 3, 4}
	upstreamChecks := make(chan error, 1)

	upstream := newWebSocketServer(t, func(connection *websocket.Conn, _ *http.Request) {
		defer connection.Close()

		if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			upstreamChecks <- err
			return
		}

		_, fullRequestPacket, err := connection.ReadMessage()
		if err != nil {
			upstreamChecks <- fmt.Errorf("read full request failed: %w", err)
			return
		}
		fullRequest := decodeClientJSONPacket(t, fullRequestPacket)
		if got := fullRequest["audio"].(map[string]any)["language"]; got != "zh-CN" {
			upstreamChecks <- fmt.Errorf("unexpected language: %v", got)
			return
		}

		_, packet, err := connection.ReadMessage()
		if err != nil {
			upstreamChecks <- fmt.Errorf("read audio packet failed: %w", err)
			return
		}
		audioPacket := parseTestClientPacket(t, packet)
		if audioPacket.MessageFlags != 0x2 {
			upstreamChecks <- fmt.Errorf("unexpected audio flags: %d", audioPacket.MessageFlags)
			return
		}
		if !bytes.Equal(audioPacket.Payload, audioChunk) {
			upstreamChecks <- fmt.Errorf("unexpected audio payload")
			return
		}

		if err := connection.WriteMessage(websocket.BinaryMessage, createDoubaoServerResponsePacket(t, createTranscriptResponse("流式识别完成"), true)); err != nil {
			upstreamChecks <- fmt.Errorf("write response failed: %w", err)
			return
		}

		upstreamChecks <- nil
	})
	defer upstream.Close()

	config := testConfig()
	config.STTProvider = "doubao"
	config.DoubaoSTTURL = httpToWSURL(upstream.URL)

	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	headers := http.Header{
		"Origin": []string{"http://frontend.test"},
	}
	client := mustDialWebSocket(t, httpToWSURL(backend.URL)+"/api/stt/ws", headers)
	defer client.Close()

	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline failed: %v", err)
	}

	if err := client.WriteJSON(browserControlMessage{Type: clientMessageStart, Language: "zh-CN"}); err != nil {
		t.Fatalf("send start message failed: %v", err)
	}

	var ready map[string]any
	if err := client.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready message failed: %v", err)
	}
	if ready["type"] != serverMessageReady {
		t.Fatalf("unexpected ready payload: %#v", ready)
	}

	if err := client.WriteMessage(websocket.BinaryMessage, audioChunk); err != nil {
		t.Fatalf("send audio chunk failed: %v", err)
	}
	if err := client.WriteJSON(browserControlMessage{Type: clientMessageStop}); err != nil {
		t.Fatalf("send stop message failed: %v", err)
	}

	var completed map[string]any
	if err := client.ReadJSON(&completed); err != nil {
		t.Fatalf("read completed message failed: %v", err)
	}
	if completed["type"] != serverMessageCompleted {
		t.Fatalf("unexpected completion payload: %#v", completed)
	}
	if completed["text"] != "流式识别完成" {
		t.Fatalf("unexpected completion text: %#v", completed)
	}

	waitForAsyncError(t, upstreamChecks)
}
