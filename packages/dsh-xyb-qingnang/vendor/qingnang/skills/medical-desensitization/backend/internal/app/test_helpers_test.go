package app

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testConfig() Config {
	dataDir, err := os.MkdirTemp("", "xiaoyibao-test-data-*")
	if err != nil {
		panic(err)
	}

	return Config{
		Port:                       "0",
		CORSAllowedOrigins:         []string{"http://frontend.test"},
		DataDir:                    dataDir,
		MaxDesensitizeBodyBytes:    defaultMaxDesensitizeBodyBytes,
		MaxDesensitizeFileBytes:    defaultMaxDesensitizeFileBytes,
		ChatProvider:               "openai",
		ChatAPIKey:                 "chat-secret",
		ChatRequestTimeout:         2 * time.Second,
		FastGPTStreamDetail:        false,
		STTProvider:                "alibaba",
		TTSProvider:                "alibaba",
		STTRequestTimeout:          2 * time.Second,
		TTSRequestTimeout:          2 * time.Second,
		AlibabaAPIKey:              "ali-secret",
		AlibabaSTTModel:            "paraformer-v1",
		AlibabaTTSModel:            "qwen3-tts-flash",
		AlibabaTTSVoice:            "loongbella",
		DoubaoSTTAppID:             "doubao-stt-app",
		DoubaoSTTAccessKey:         "doubao-stt-token",
		DoubaoSTTResourceID:        "volc.seedasr.sauc.duration",
		DoubaoSTTModelName:         "bigmodel",
		DoubaoSTTLanguage:          "zh-CN",
		DoubaoSTTEnableITN:         true,
		DoubaoSTTEnablePunc:        true,
		DoubaoSTTEnableDDC:         false,
		DoubaoSTTEnableNonstream:   true,
		DoubaoSTTShowUtterances:    true,
		DoubaoSTTResultType:        "full",
		DoubaoSTTEndWindowSize:     800,
		DoubaoSTTForceToSpeechTime: 1000,
		DoubaoTTSAppID:             "doubao-tts-app",
		DoubaoTTSAccessKey:         "doubao-tts-token",
		DoubaoTTSResourceID:        "seed-tts-2.0",
		DoubaoTTSSpeaker:           "zh_female_cancan_mars_bigtts",
		DoubaoTTSFormat:            "mp3",
		DoubaoTTSSampleRate:        24000,
	}
}

func newBackendHTTPServer(t *testing.T, config Config) *httptest.Server {
	t.Helper()
	server := NewServer(config)
	return httptest.NewServer(server.Handler())
}

func newWebSocketServer(t *testing.T, handler func(*websocket.Conn, *http.Request)) *httptest.Server {
	t.Helper()

	upgrader := websocket.Upgrader{
		CheckOrigin: func(*http.Request) bool {
			return true
		},
	}

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade failed: %v", err)
		}
		handler(connection, r)
	}))
}

func httpToWSURL(rawURL string) string {
	return "ws" + strings.TrimPrefix(rawURL, "http")
}

func createTestWAV(sampleRate int, channels int, samples []int16) []byte {
	dataLength := len(samples) * 2
	buffer := bytes.NewBuffer(make([]byte, 0, 44+dataLength))
	_ = binary.Write(buffer, binary.LittleEndian, []byte("RIFF"))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(36+dataLength))
	_ = binary.Write(buffer, binary.LittleEndian, []byte("WAVE"))
	_ = binary.Write(buffer, binary.LittleEndian, []byte("fmt "))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(16))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(1))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(channels))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(sampleRate))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(sampleRate*channels*2))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(channels*2))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(16))
	_ = binary.Write(buffer, binary.LittleEndian, []byte("data"))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(dataLength))
	for _, sample := range samples {
		_ = binary.Write(buffer, binary.LittleEndian, sample)
	}
	return buffer.Bytes()
}

func createMultipartRequest(t *testing.T, url string, fileName string, mimeType string, payload []byte) *http.Request {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fileWriter, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatalf("create form file failed: %v", err)
	}
	if _, err := fileWriter.Write(payload); err != nil {
		t.Fatalf("write form file failed: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer failed: %v", err)
	}

	request, err := http.NewRequest(http.MethodPost, url, &body)
	if err != nil {
		t.Fatalf("create request failed: %v", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Origin", "http://frontend.test")
	if mimeType != "" {
		request.Header.Set("X-Test-Content-Type", mimeType)
	}
	return request
}

type testClientPacket struct {
	MessageType   byte
	MessageFlags  byte
	Serialization byte
	Compression   byte
	Payload       []byte
}

func parseTestClientPacket(t *testing.T, packet []byte) testClientPacket {
	t.Helper()

	if len(packet) < 8 {
		t.Fatalf("packet too short: %d", len(packet))
	}

	headerSize := int(packet[0]&0x0F) * 4
	if headerSize < 4 || len(packet) < headerSize+4 {
		t.Fatalf("invalid header size: %d", headerSize)
	}

	messageType := packet[1] >> 4
	messageFlags := packet[1] & 0x0F
	serialization := packet[2] >> 4
	compression := packet[2] & 0x0F
	payloadSize := int(binary.BigEndian.Uint32(packet[headerSize : headerSize+4]))
	if len(packet) < headerSize+4+payloadSize {
		t.Fatalf("invalid payload size: %d", payloadSize)
	}

	payload := packet[headerSize+4 : headerSize+4+payloadSize]
	if compression == doubaoCompressionGZIP {
		var err error
		payload, err = gunzipBytes(payload)
		if err != nil {
			t.Fatalf("gunzip payload failed: %v", err)
		}
	}

	return testClientPacket{
		MessageType:   messageType,
		MessageFlags:  messageFlags,
		Serialization: serialization,
		Compression:   compression,
		Payload:       payload,
	}
}

func decodeClientJSONPacket(t *testing.T, packet []byte) map[string]any {
	t.Helper()
	parsed := parseTestClientPacket(t, packet)
	if parsed.Serialization != doubaoSerializationJSON {
		t.Fatalf("unexpected serialization: %d", parsed.Serialization)
	}

	var payload map[string]any
	if err := json.Unmarshal(parsed.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload failed: %v", err)
	}
	return payload
}

func createDoubaoServerResponsePacket(t *testing.T, payload any, final bool) []byte {
	t.Helper()

	rawPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload failed: %v", err)
	}
	compressedPayload, err := gzipBytes(rawPayload)
	if err != nil {
		t.Fatalf("gzip payload failed: %v", err)
	}

	flags := byte(0x1)
	if final {
		flags = 0x3
	}

	header := createDoubaoHeader(doubaoMessageTypeFullServer, flags, doubaoSerializationJSON, doubaoCompressionGZIP)
	sequence := make([]byte, 4)
	payloadSize := make([]byte, 4)
	writeUint32BE(sequence, 1)
	writeUint32BE(payloadSize, uint32(len(compressedPayload)))

	return bytes.Join([][]byte{header, sequence, payloadSize, compressedPayload}, nil)
}

func createTranscriptResponse(text string) map[string]any {
	return map[string]any{
		"result": map[string]any{
			"text": text,
			"utterances": []map[string]any{
				{
					"text":     text,
					"definite": true,
				},
			},
		},
		"audio_info": map[string]any{
			"duration": 1000,
		},
	}
}

func mustReadBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body failed: %v", err)
	}
	return string(body)
}

func mustDialWebSocket(t *testing.T, rawURL string, headers http.Header) *websocket.Conn {
	t.Helper()
	connection, response, err := websocket.DefaultDialer.Dial(rawURL, headers)
	if err != nil {
		status := ""
		if response != nil {
			status = response.Status
		}
		t.Fatalf("websocket dial failed: %v %s", err, status)
	}
	return connection
}

func dumpJSON(t *testing.T, value any) string {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal json failed: %v", err)
	}
	return string(payload)
}

func assertHeader(t *testing.T, headers http.Header, key string, expected string) {
	t.Helper()
	if got := headers.Get(key); got != expected {
		t.Fatalf("header %s mismatch: got %q want %q", key, got, expected)
	}
}

func waitForAsyncError(t *testing.T, ch <-chan error) {
	t.Helper()

	select {
	case err := <-ch:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async assertion")
	}
}
