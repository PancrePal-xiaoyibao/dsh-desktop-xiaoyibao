package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	sttWebSocketPath              = "/api/stt/ws"
	doubaoProtocolVersion         = 0x1
	doubaoHeaderSize              = 0x1
	doubaoMessageTypeFullClient   = 0x1
	doubaoMessageTypeAudioOnly    = 0x2
	doubaoMessageTypeFullServer   = 0x9
	doubaoMessageTypeError        = 0xF
	doubaoSerializationNone       = 0x0
	doubaoSerializationJSON       = 0x1
	doubaoCompressionGZIP         = 0x1
	doubaoAudioChunkBytes         = 6400
	doubaoAudioSampleRate         = 16000
	doubaoAudioBits               = 16
	doubaoAudioChannels           = 1
	clientMessageStart            = "start"
	clientMessageStop             = "stop"
	serverMessageReady            = "ready"
	serverMessageTranscript       = "transcript"
	serverMessageCompleted        = "completed"
	serverMessageError            = "error"
	websocketClosePolicyViolation = 1008
	websocketCloseInternalError   = 1011
)

type doubaoServerMessage struct {
	Type    string
	Final   bool
	Code    uint32
	Message string
	Payload any
}

type transcriptPayload struct {
	Text       string `json:"text"`
	Utterances any    `json:"utterances,omitempty"`
	DurationMS int    `json:"durationMs,omitempty"`
	IsFinal    bool   `json:"isFinal,omitempty"`
	LogID      string `json:"logId,omitempty"`
}

type browserControlMessage struct {
	Type     string `json:"type"`
	Language string `json:"language,omitempty"`
}

func (s *Server) handleSTT(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if !hostMatchesOrigin(r.Header.Get("Origin"), r.Header.Get("X-Forwarded-Host")) &&
		!hostMatchesOrigin(r.Header.Get("Origin"), r.Header.Get("Host")) &&
		r.Header.Get("Origin") != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "非法请求来源"})
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "未提供音频文件"})
		return
	}

	file, fileHeader, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "未提供音频文件"})
		return
	}
	defer file.Close()

	audioBuffer, err := io.ReadAll(file)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	fileName := "recording.wav"
	if fileHeader != nil && fileHeader.Filename != "" {
		fileName = fileHeader.Filename
	}

	mimeType := ""
	if fileHeader != nil {
		mimeType = fileHeader.Header.Get("Content-Type")
	}

	ContextLogf(
		r.Context(),
		"stt.request provider=%s filename=%q bytes=%d mime=%q",
		s.config.STTProvider,
		fileName,
		len(audioBuffer),
		mimeType,
	)

	text, err := s.transcribeAudioFile(r.Context(), audioBuffer, fileName, mimeType)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
	ContextLogf(r.Context(), "stt.completed provider=%s text_chars=%d", s.config.STTProvider, len([]rune(text)))
	ContextDebugf(r.Context(), "stt.result text=%q", truncate(text, 120))
}

func (s *Server) transcribeAudioFile(ctx context.Context, audioBuffer []byte, fileName, mimeType string) (string, error) {
	if len(audioBuffer) == 0 {
		return "", newAppError(http.StatusBadRequest, "未提供音频文件")
	}

	if s.config.STTProvider == "doubao" {
		return s.transcribeWithDoubao(ctx, audioBuffer, fileName, mimeType)
	}

	return s.transcribeWithAlibaba(ctx, audioBuffer, fileName, mimeType)
}

func (s *Server) transcribeWithAlibaba(ctx context.Context, audioBuffer []byte, fileName, mimeType string) (string, error) {
	if s.config.AlibabaAPIKey == "" || s.config.AlibabaBaseURL == "" {
		return "", newAppError(http.StatusInternalServerError, "语音服务配置不完整，请联系管理员")
	}

	ContextDebugf(
		ctx,
		"stt.alibaba upstream=%s model=%s filename=%q bytes=%d mime=%q",
		logSafeURL(s.config.AlibabaBaseURL+"/audio/transcriptions"),
		s.config.AlibabaSTTModel,
		fileName,
		len(audioBuffer),
		mimeType,
	)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(audioBuffer); err != nil {
		return "", err
	}
	if err = writer.WriteField("model", s.config.AlibabaSTTModel); err != nil {
		return "", err
	}
	if err = writer.Close(); err != nil {
		return "", err
	}

	response, err := fetchWithTimeout(ctx, s.config.STTRequestTimeout, func(requestCtx context.Context) (*http.Response, error) {
		request, requestErr := http.NewRequestWithContext(requestCtx, http.MethodPost, s.config.AlibabaBaseURL+"/audio/transcriptions", &body)
		if requestErr != nil {
			return nil, requestErr
		}
		request.Header.Set("Authorization", "Bearer "+s.config.AlibabaAPIKey)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		if mimeType != "" {
			request.Header.Set("X-File-Content-Type", mimeType)
		}
		return s.httpClient.Do(request)
	})
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", newAppError(
			http.StatusBadGateway,
			"语音识别服务暂时不可用，请稍后重试",
			"阿里云 STT 错误: "+response.Status+" "+safeReadText(cloneResponse(response), 1024),
		)
	}

	var payload struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", err
	}

	text := strings.TrimSpace(payload.Text)
	if text == "" {
		return "", newAppError(http.StatusInternalServerError, "未能识别到语音内容，请重试")
	}

	ContextDebugf(ctx, "stt.alibaba upstream_ok text_chars=%d", len([]rune(text)))

	return text, nil
}

func (s *Server) transcribeWithDoubao(ctx context.Context, audioBuffer []byte, fileName, mimeType string) (string, error) {
	if s.config.DoubaoSTTAppID == "" || s.config.DoubaoSTTAccessKey == "" {
		return "", newAppError(http.StatusInternalServerError, "语音服务配置不完整，请联系管理员")
	}

	pcmBuffer, err := normalizeUploadedDoubaoAudio(audioBuffer, fileName, mimeType)
	if err != nil {
		return "", err
	}

	connectionID := "stt-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	ContextDebugf(
		ctx,
		"stt.doubao upstream=%s connection_id=%s filename=%q upload_bytes=%d pcm_bytes=%d",
		s.config.DoubaoSTTURL,
		connectionID,
		fileName,
		len(audioBuffer),
		len(pcmBuffer),
	)
	headers := http.Header{}
	headers.Set("X-Api-App-Key", s.config.DoubaoSTTAppID)
	headers.Set("X-Api-Access-Key", s.config.DoubaoSTTAccessKey)
	headers.Set("X-Api-Resource-Id", s.config.DoubaoSTTResourceID)
	headers.Set("X-Api-Connect-Id", connectionID)

	upstream, response, err := websocket.DefaultDialer.DialContext(ctx, s.config.DoubaoSTTURL, headers)
	if err != nil {
		if response != nil {
			return "", newAppError(http.StatusBadGateway, "语音识别服务暂时不可用，请稍后重试", "豆包 STT 握手失败: "+response.Status)
		}
		return "", newAppError(http.StatusBadGateway, "语音识别服务暂时不可用，请稍后重试", "豆包 STT 连接失败: "+err.Error())
	}
	defer upstream.Close()

	if err := upstream.SetWriteDeadline(time.Now().Add(s.config.STTRequestTimeout)); err != nil {
		return "", err
	}
	if err := upstream.WriteMessage(websocket.BinaryMessage, createDoubaoFullRequestPacket(s.config, s.config.DoubaoSTTLanguage, connectionID)); err != nil {
		return "", err
	}

	chunks := splitBytes(pcmBuffer, doubaoAudioChunkBytes)
	if len(chunks) == 0 {
		return "", newAppError(http.StatusBadRequest, "未检测到有效语音输入")
	}
	ContextDebugf(ctx, "stt.doubao chunk_count=%d chunk_size=%d", len(chunks), doubaoAudioChunkBytes)

	for index, chunk := range chunks {
		if err := upstream.WriteMessage(websocket.BinaryMessage, createDoubaoAudioPacket(chunk, index == len(chunks)-1)); err != nil {
			return "", err
		}
	}

	if err := upstream.SetReadDeadline(time.Now().Add(s.config.STTRequestTimeout)); err != nil {
		return "", err
	}

	latestText := ""
	for {
		_, messageData, readErr := upstream.ReadMessage()
		if readErr != nil {
			break
		}

		message, parseErr := parseDoubaoServerMessage(messageData)
		if parseErr != nil {
			return "", parseErr
		}

		if message.Type == "error" {
			return "", newAppError(http.StatusBadGateway, "语音识别服务暂时不可用，请稍后重试", fmt.Sprintf("豆包 STT 错误: code=%d message=%s", message.Code, message.Message))
		}

		text, _ := extractTranscriptText(message.Payload)
		if text != "" {
			latestText = text
		}

		if message.Final {
			break
		}
	}

	if latestText == "" {
		return "", newAppError(http.StatusInternalServerError, "未能识别到语音内容，请重试")
	}

	ContextDebugf(ctx, "stt.doubao upstream_ok text_chars=%d connection_id=%s", len([]rune(latestText)), connectionID)

	return latestText, nil
}

func (s *Server) handleSTTWebSocket(w http.ResponseWriter, r *http.Request) {
	r = ensureRequestContext(r)
	w.Header().Set("X-Request-Id", requestIDFromContext(r.Context()))
	ContextLogf(r.Context(), "stt.ws.request origin=%q remote=%q", r.Header.Get("Origin"), r.RemoteAddr)

	if s.config.STTProvider != "doubao" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "当前 STT_PROVIDER 不是 doubao，流式识别不可用"})
		return
	}

	if !isOriginAllowed(r.Header.Get("Origin"), s.config.CORSAllowedOrigins) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "非法来源，拒绝连接"})
		return
	}

	clientConn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		ContextErrorf(r.Context(), "stt.ws.upgrade_failed error=%v", err)
		return
	}

	session := newSTTBridgeSession(s, clientConn, r.Context())
	session.run(r.Context())
}

type sttBridgeSession struct {
	server *Server
	client *websocket.Conn
	ctx    context.Context

	clientWriteMu sync.Mutex

	upstream        *websocket.Conn
	upstreamWriteMu sync.Mutex
	logID           string
	traceID         string
	connectionID    string
	language        string
	started         bool
	stopped         bool
	completed       bool
	totalAudioBytes int
	pendingChunk    []byte
	latestText      string
	queuedChunks    [][]byte
}

func newSTTBridgeSession(server *Server, client *websocket.Conn, ctx context.Context) *sttBridgeSession {
	return &sttBridgeSession{
		server:       server,
		client:       client,
		ctx:          ctx,
		language:     server.config.DoubaoSTTLanguage,
		traceID:      "stt-" + strconv.FormatInt(time.Now().UnixNano(), 10),
		connectionID: "conn-" + strconv.FormatInt(time.Now().UnixNano(), 10),
	}
}

func (s *sttBridgeSession) run(ctx context.Context) {
	defer s.client.Close()
	ContextLogf(s.ctx, "stt.ws.session_open trace_id=%s connection_id=%s language=%s", s.traceID, s.connectionID, s.language)
	defer ContextLogf(
		s.ctx,
		"stt.ws.session_close trace_id=%s connection_id=%s total_audio_bytes=%d completed=%t",
		s.traceID,
		s.connectionID,
		s.totalAudioBytes,
		s.completed,
	)

	for {
		messageType, payload, err := s.client.ReadMessage()
		if err != nil {
			ContextDebugf(s.ctx, "stt.ws.client_closed trace_id=%s error=%v", s.traceID, err)
			s.closeUpstream()
			return
		}

		if messageType == websocket.BinaryMessage {
			s.handleClientAudio(payload)
			continue
		}

		var control browserControlMessage
		if err := json.Unmarshal(payload, &control); err != nil {
			s.fail(newAppError(http.StatusBadRequest, "无效的 STT 控制消息"))
			return
		}

		switch control.Type {
		case clientMessageStart:
			if s.started {
				s.fail(newAppError(http.StatusConflict, "识别会话已启动"))
				return
			}
			if strings.TrimSpace(control.Language) != "" {
				s.language = strings.TrimSpace(control.Language)
			}
			ContextDebugf(s.ctx, "stt.ws.control_start trace_id=%s language=%s", s.traceID, s.language)
			if err := s.openUpstream(ctx); err != nil {
				s.fail(err)
				return
			}
		case clientMessageStop:
			s.stopped = true
			ContextDebugf(s.ctx, "stt.ws.control_stop trace_id=%s total_audio_bytes=%d", s.traceID, s.totalAudioBytes)
			s.finishStreaming()
		default:
			s.fail(newAppError(http.StatusBadRequest, "未知的 STT 控制消息"))
			return
		}
	}
}

func (s *sttBridgeSession) openUpstream(ctx context.Context) error {
	headers := http.Header{}
	headers.Set("X-Api-App-Key", s.server.config.DoubaoSTTAppID)
	headers.Set("X-Api-Access-Key", s.server.config.DoubaoSTTAccessKey)
	headers.Set("X-Api-Resource-Id", s.server.config.DoubaoSTTResourceID)
	headers.Set("X-Api-Connect-Id", s.connectionID)

	upstream, response, err := websocket.DefaultDialer.DialContext(ctx, s.server.config.DoubaoSTTURL, headers)
	if err != nil {
		if response != nil {
			return newAppError(http.StatusBadGateway, "语音识别服务暂时不可用，请稍后重试", "豆包 STT 握手失败: "+response.Status)
		}
		return newAppError(http.StatusBadGateway, "语音识别服务暂时不可用，请稍后重试", "豆包 STT 连接失败: "+err.Error())
	}

	s.upstream = upstream
	s.started = true
	s.logID = response.Header.Get("X-Tt-Logid")
	ContextLogf(
		s.ctx,
		"stt.ws.upstream_open trace_id=%s connection_id=%s log_id=%s language=%s",
		s.traceID,
		s.connectionID,
		s.logID,
		s.language,
	)

	if err := s.writeUpstream(websocket.BinaryMessage, createDoubaoFullRequestPacket(s.server.config, s.language, s.traceID)); err != nil {
		return err
	}

	if err := s.writeJSON(serverMessageReady, map[string]any{
		"provider":     "doubao",
		"traceId":      s.traceID,
		"connectionId": s.connectionID,
		"logId":        s.logID,
	}); err != nil {
		return err
	}

	go s.readUpstream()
	s.flushQueuedAudio()
	s.finishStreaming()
	return nil
}

func (s *sttBridgeSession) readUpstream() {
	for {
		_, payload, err := s.upstream.ReadMessage()
		if err != nil {
			if !s.completed && s.latestText != "" {
				s.completed = true
				_ = s.writeJSON(serverMessageCompleted, transcriptPayload{
					Text:    s.latestText,
					IsFinal: true,
					LogID:   s.logID,
				})
			}
			ContextDebugf(s.ctx, "stt.ws.upstream_closed trace_id=%s log_id=%s error=%v", s.traceID, s.logID, err)
			_ = s.client.Close()
			return
		}

		message, parseErr := parseDoubaoServerMessage(payload)
		if parseErr != nil {
			s.fail(parseErr)
			return
		}

		if message.Type == "error" {
			s.fail(newAppError(http.StatusBadGateway, "语音识别服务暂时不可用，请稍后重试", fmt.Sprintf("豆包 STT 错误: code=%d message=%s", message.Code, message.Message)))
			return
		}

		text, utterances := extractTranscriptText(message.Payload)
		if text != "" {
			s.latestText = text
			ContextDebugf(s.ctx, "stt.ws.transcript trace_id=%s final=%t text=%q", s.traceID, message.Final, truncate(text, 120))
		}

		messageType := serverMessageTranscript
		if message.Final {
			messageType = serverMessageCompleted
			s.completed = true
		}

		if err := s.writeJSON(messageType, transcriptPayload{
			Text:       firstNonEmpty(text, s.latestText),
			Utterances: utterances,
			IsFinal:    message.Final,
			LogID:      s.logID,
		}); err != nil {
			return
		}

		if message.Final {
			ContextLogf(s.ctx, "stt.ws.completed trace_id=%s log_id=%s text_chars=%d total_audio_bytes=%d", s.traceID, s.logID, len([]rune(firstNonEmpty(text, s.latestText))), s.totalAudioBytes)
			_ = s.client.Close()
			return
		}
	}
}

func (s *sttBridgeSession) handleClientAudio(audioBuffer []byte) {
	if len(audioBuffer) == 0 {
		return
	}

	if !s.started {
		s.fail(newAppError(http.StatusBadRequest, "请先初始化语音识别会话"))
		return
	}

	s.totalAudioBytes += len(audioBuffer)
	ContextDebugf(s.ctx, "stt.ws.audio_chunk trace_id=%s chunk_bytes=%d total_audio_bytes=%d", s.traceID, len(audioBuffer), s.totalAudioBytes)

	if s.upstream == nil {
		s.queuedChunks = append(s.queuedChunks, audioBuffer)
		return
	}

	if s.pendingChunk != nil {
		if err := s.writeUpstream(websocket.BinaryMessage, createDoubaoAudioPacket(s.pendingChunk, false)); err != nil {
			s.fail(err)
			return
		}
	}
	s.pendingChunk = append([]byte(nil), audioBuffer...)
}

func (s *sttBridgeSession) flushQueuedAudio() {
	queued := s.queuedChunks
	s.queuedChunks = nil
	for _, chunk := range queued {
		s.handleClientAudio(chunk)
	}
}

func (s *sttBridgeSession) finishStreaming() {
	if !s.stopped || s.upstream == nil {
		return
	}

	s.flushQueuedAudio()
	if s.totalAudioBytes == 0 {
		s.fail(newAppError(http.StatusBadRequest, "未检测到语音输入"))
		return
	}

	if s.pendingChunk != nil {
		ContextDebugf(s.ctx, "stt.ws.flush_final_chunk trace_id=%s chunk_bytes=%d", s.traceID, len(s.pendingChunk))
		if err := s.writeUpstream(websocket.BinaryMessage, createDoubaoAudioPacket(s.pendingChunk, true)); err != nil {
			s.fail(err)
			return
		}
		s.pendingChunk = nil
		return
	}

	ContextDebugf(s.ctx, "stt.ws.flush_empty_final trace_id=%s", s.traceID)
	if err := s.writeUpstream(websocket.BinaryMessage, createDoubaoAudioPacket(nil, true)); err != nil {
		s.fail(err)
	}
}

func (s *sttBridgeSession) writeJSON(messageType string, payload any) error {
	body := map[string]any{"type": messageType}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(rawPayload, &body); err != nil {
		return err
	}

	s.clientWriteMu.Lock()
	defer s.clientWriteMu.Unlock()
	return s.client.WriteJSON(body)
}

func (s *sttBridgeSession) writeUpstream(messageType int, payload []byte) error {
	if s.upstream == nil {
		return nil
	}

	s.upstreamWriteMu.Lock()
	defer s.upstreamWriteMu.Unlock()
	_ = s.upstream.SetWriteDeadline(time.Now().Add(s.server.config.STTRequestTimeout))
	return s.upstream.WriteMessage(messageType, payload)
}

func (s *sttBridgeSession) closeUpstream() {
	if s.upstream != nil {
		_ = s.upstream.Close()
	}
}

func (s *sttBridgeSession) fail(err error) {
	var appErr *appError
	if !errors.As(err, &appErr) {
		appErr = newAppError(http.StatusInternalServerError, "语音识别服务内部错误", err.Error())
	}
	if appErr.LogMessage != "" {
		ContextErrorf(s.ctx, "stt.ws.failed trace_id=%s log_id=%s status=%d message=%q detail=%s", s.traceID, s.logID, appErr.Status, appErr.Message, appErr.LogMessage)
	} else {
		ContextErrorf(s.ctx, "stt.ws.failed trace_id=%s log_id=%s status=%d message=%q", s.traceID, s.logID, appErr.Status, appErr.Message)
	}
	_ = s.writeJSON(serverMessageError, map[string]any{
		"message": appErr.Message,
		"logId":   s.logID,
	})
	closeCode := websocketCloseInternalError
	if appErr.Status >= 400 && appErr.Status < 500 {
		closeCode = websocketClosePolicyViolation
	}
	_ = s.client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(closeCode, appErr.Message), time.Now().Add(2*time.Second))
	s.closeUpstream()
	_ = s.client.Close()
}

func createDoubaoFullRequestPacket(config Config, language, traceID string) []byte {
	payload := map[string]any{
		"user": map[string]any{
			"uid": traceID,
		},
		"audio": map[string]any{
			"format":   "pcm",
			"codec":    "raw",
			"rate":     doubaoAudioSampleRate,
			"bits":     doubaoAudioBits,
			"channel":  doubaoAudioChannels,
			"language": language,
		},
		"request": map[string]any{
			"model_name":           config.DoubaoSTTModelName,
			"enable_nonstream":     config.DoubaoSTTEnableNonstream,
			"enable_itn":           config.DoubaoSTTEnableITN,
			"enable_punc":          config.DoubaoSTTEnablePunc,
			"enable_ddc":           config.DoubaoSTTEnableDDC,
			"show_utterances":      config.DoubaoSTTShowUtterances,
			"result_type":          config.DoubaoSTTResultType,
			"end_window_size":      config.DoubaoSTTEndWindowSize,
			"force_to_speech_time": config.DoubaoSTTForceToSpeechTime,
		},
	}
	rawPayload, _ := json.Marshal(payload)
	compressedPayload, _ := gzipBytes(rawPayload)

	header := createDoubaoHeader(doubaoMessageTypeFullClient, 0x0, doubaoSerializationJSON, doubaoCompressionGZIP)
	body := make([]byte, 4)
	writeUint32BE(body, uint32(len(compressedPayload)))
	return bytes.Join([][]byte{header, body, compressedPayload}, nil)
}

func createDoubaoAudioPacket(audioBuffer []byte, isLast bool) []byte {
	compressedPayload, _ := gzipBytes(audioBuffer)
	flags := byte(0x0)
	if isLast {
		flags = 0x2
	}
	header := createDoubaoHeader(doubaoMessageTypeAudioOnly, flags, doubaoSerializationNone, doubaoCompressionGZIP)
	body := make([]byte, 4)
	writeUint32BE(body, uint32(len(compressedPayload)))
	return bytes.Join([][]byte{header, body, compressedPayload}, nil)
}

func createDoubaoHeader(messageType, messageFlags, serialization, compression byte) []byte {
	return []byte{
		(doubaoProtocolVersion << 4) | doubaoHeaderSize,
		(messageType << 4) | messageFlags,
		(serialization << 4) | compression,
		0x00,
	}
}

func parseDoubaoServerMessage(packet []byte) (doubaoServerMessage, error) {
	if len(packet) < 8 {
		return doubaoServerMessage{}, newAppError(http.StatusBadGateway, "语音识别服务返回了无法解析的数据")
	}

	headerSize := int(packet[0]&0x0F) * 4
	if len(packet) < headerSize+8 {
		return doubaoServerMessage{}, newAppError(http.StatusBadGateway, "语音识别服务返回了无法解析的数据")
	}
	messageType := packet[1] >> 4
	messageFlags := packet[1] & 0x0F
	serialization := packet[2] >> 4
	compression := packet[2] & 0x0F
	body := packet[headerSize:]

	switch messageType {
	case doubaoMessageTypeFullServer:
		payloadSize := binary.BigEndian.Uint32(body[4:8])
		payload, err := decodeDoubaoPayload(body[8:8+payloadSize], serialization, compression)
		if err != nil {
			return doubaoServerMessage{}, err
		}
		return doubaoServerMessage{
			Type:    "response",
			Final:   messageFlags == 0x3,
			Payload: payload,
		}, nil
	case doubaoMessageTypeError:
		payloadSize := binary.BigEndian.Uint32(body[4:8])
		payload, err := decodeDoubaoPayload(body[8:8+payloadSize], serialization, compression)
		if err != nil {
			return doubaoServerMessage{}, err
		}
		message := ""
		if payloadMap, ok := payload.(map[string]any); ok {
			message = firstNonEmpty(asString(payloadMap["message"]), asString(payloadMap["error"]))
		}
		return doubaoServerMessage{
			Type:    "error",
			Code:    binary.BigEndian.Uint32(body[0:4]),
			Message: message,
			Payload: payload,
		}, nil
	default:
		return doubaoServerMessage{}, newAppError(http.StatusBadGateway, "语音识别服务返回了无法解析的数据")
	}
}

func decodeDoubaoPayload(payload []byte, serialization, compression byte) (any, error) {
	rawPayload := payload
	if compression == doubaoCompressionGZIP {
		decompressed, err := gunzipBytes(payload)
		if err != nil {
			return nil, err
		}
		rawPayload = decompressed
	}

	if serialization == doubaoSerializationNone {
		return rawPayload, nil
	}

	if serialization == doubaoSerializationJSON {
		var decoded any
		if err := json.Unmarshal(rawPayload, &decoded); err != nil {
			return nil, newAppError(http.StatusBadGateway, "语音识别服务返回了无法解析的数据")
		}
		return decoded, nil
	}

	return nil, newAppError(http.StatusBadGateway, "语音识别服务返回了无法解析的数据")
}

func normalizeUploadedDoubaoAudio(audioBuffer []byte, fileName, mimeType string) ([]byte, error) {
	switch detectAudioFormat(fileName, mimeType) {
	case "wav":
		return parseWAVPCM(audioBuffer)
	case "pcm":
		return audioBuffer, nil
	default:
		return nil, newAppError(http.StatusBadRequest, "豆包 STT 上传当前仅支持 16kHz 单声道 PCM/WAV 音频")
	}
}

func detectAudioFormat(fileName, mimeType string) string {
	name := strings.ToLower(fileName)
	ext := strings.ToLower(filepath.Ext(name))
	contentType := strings.ToLower(mimeType)

	if ext == ".wav" || strings.Contains(contentType, "wav") {
		return "wav"
	}
	if ext == ".pcm" || strings.Contains(contentType, "pcm") {
		return "pcm"
	}
	return "unknown"
}

func parseWAVPCM(audioBuffer []byte) ([]byte, error) {
	if len(audioBuffer) < 44 || string(audioBuffer[0:4]) != "RIFF" || string(audioBuffer[8:12]) != "WAVE" {
		return nil, newAppError(http.StatusBadRequest, "仅支持标准 WAV 音频文件")
	}

	offset := 12
	audioFormat := uint16(0)
	channelCount := uint16(0)
	sampleRate := uint32(0)
	bitsPerSample := uint16(0)
	var pcmData []byte

	for offset+8 <= len(audioBuffer) {
		chunkID := string(audioBuffer[offset : offset+4])
		chunkSize := int(binary.LittleEndian.Uint32(audioBuffer[offset+4 : offset+8]))
		chunkStart := offset + 8
		chunkEnd := chunkStart + chunkSize
		if chunkEnd > len(audioBuffer) {
			return nil, newAppError(http.StatusBadRequest, "音频文件格式无效")
		}

		switch chunkID {
		case "fmt ":
			audioFormat = binary.LittleEndian.Uint16(audioBuffer[chunkStart : chunkStart+2])
			channelCount = binary.LittleEndian.Uint16(audioBuffer[chunkStart+2 : chunkStart+4])
			sampleRate = binary.LittleEndian.Uint32(audioBuffer[chunkStart+4 : chunkStart+8])
			bitsPerSample = binary.LittleEndian.Uint16(audioBuffer[chunkStart+14 : chunkStart+16])
		case "data":
			pcmData = audioBuffer[chunkStart:chunkEnd]
		}

		offset = chunkEnd
		if chunkSize%2 == 1 {
			offset++
		}
	}

	if audioFormat != 1 || pcmData == nil {
		return nil, newAppError(http.StatusBadRequest, "仅支持 PCM 编码的 WAV 音频")
	}
	if channelCount != doubaoAudioChannels || sampleRate != doubaoAudioSampleRate || bitsPerSample != doubaoAudioBits {
		return nil, newAppError(http.StatusBadRequest, "豆包 STT 仅支持 16kHz、16bit、单声道 PCM 音频")
	}
	return pcmData, nil
}

func splitBytes(buffer []byte, chunkSize int) [][]byte {
	if len(buffer) == 0 {
		return nil
	}
	chunks := make([][]byte, 0, len(buffer)/chunkSize+1)
	for offset := 0; offset < len(buffer); offset += chunkSize {
		end := offset + chunkSize
		if end > len(buffer) {
			end = len(buffer)
		}
		chunks = append(chunks, buffer[offset:end])
	}
	return chunks
}

func extractTranscriptText(payload any) (string, any) {
	payloadMap, ok := payload.(map[string]any)
	if !ok {
		return "", nil
	}

	resultValue, exists := payloadMap["result"]
	if !exists {
		return "", nil
	}

	resultMap, ok := resultValue.(map[string]any)
	if !ok {
		if resultList, listOK := resultValue.([]any); listOK && len(resultList) > 0 {
			resultMap, _ = resultList[0].(map[string]any)
		}
	}

	if resultMap == nil {
		return "", nil
	}

	text := strings.TrimSpace(asString(resultMap["text"]))
	return text, resultMap["utterances"]
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return ""
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
