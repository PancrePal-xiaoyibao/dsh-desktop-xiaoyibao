package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	doubaoTTSEventSessionFinished = 152
	doubaoTTSEventSessionFailed   = 153
	doubaoTTSEventSentenceStart   = 350
	doubaoTTSEventSentenceEnd     = 351
	doubaoTTSEventResponse        = 352
	doubaoSuccessCode             = 20000000
)

type ttsRequest struct {
	Text string `json:"text"`
}

type doubaoSSEPayload struct {
	Audio      string         `json:"audio"`
	Data       string         `json:"data"`
	Event      any            `json:"event"`
	Message    string         `json:"message"`
	StatusCode int            `json:"status_code"`
	Usage      map[string]any `json:"usage"`
}

func (s *Server) handleTTS(w http.ResponseWriter, r *http.Request) {
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

	var body ttsRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "未提供有效文本"})
		return
	}

	cleanText := cleanTTSText(body.Text)
	if cleanText == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "文本内容为空，无法生成语音"})
		return
	}

	if len([]rune(cleanText)) > maxTTSTextLength {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "文本过长，请控制在 2000 个字符以内"})
		return
	}

	ContextLogf(r.Context(), "tts.request provider=%s text_chars=%d", s.config.TTSProvider, len([]rune(cleanText)))
	ContextDebugf(r.Context(), "tts.request_preview text=%q", truncate(cleanText, 80))

	audio, contentType, err := s.synthesizeSpeech(r.Context(), cleanText)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(audio)
	ContextLogf(r.Context(), "tts.completed provider=%s content_type=%s audio_bytes=%d", s.config.TTSProvider, contentType, len(audio))
}

func (s *Server) synthesizeSpeech(ctx context.Context, text string) ([]byte, string, error) {
	if s.config.TTSProvider == "doubao" {
		return s.synthesizeWithDoubao(ctx, text)
	}

	return s.synthesizeWithAlibaba(ctx, text)
}

func (s *Server) synthesizeWithAlibaba(ctx context.Context, text string) ([]byte, string, error) {
	if s.config.AlibabaAPIKey == "" || s.config.AlibabaBaseURL == "" {
		return nil, "", newAppError(http.StatusInternalServerError, "语音服务配置不完整，请联系管理员")
	}

	ContextDebugf(ctx, "tts.alibaba upstream=%s model=%s voice=%s", logSafeURL(s.config.AlibabaBaseURL+"/audio/speech"), s.config.AlibabaTTSModel, s.config.AlibabaTTSVoice)

	requestBody, err := json.Marshal(map[string]any{
		"model":           s.config.AlibabaTTSModel,
		"input":           text,
		"voice":           s.config.AlibabaTTSVoice,
		"response_format": "mp3",
		"speed":           1.0,
	})
	if err != nil {
		return nil, "", err
	}

	response, err := fetchWithTimeout(ctx, s.config.TTSRequestTimeout, func(requestCtx context.Context) (*http.Response, error) {
		request, requestErr := http.NewRequestWithContext(requestCtx, http.MethodPost, s.config.AlibabaBaseURL+"/audio/speech", bytes.NewReader(requestBody))
		if requestErr != nil {
			return nil, requestErr
		}
		request.Header.Set("Authorization", "Bearer "+s.config.AlibabaAPIKey)
		request.Header.Set("Content-Type", "application/json")
		return s.httpClient.Do(request)
	})
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", newAppError(
			http.StatusBadGateway,
			"语音合成服务暂时不可用，请稍后重试",
			"阿里云 TTS 错误: "+response.Status+" "+safeReadText(cloneResponse(response), 1024),
		)
	}

	audio, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, "", err
	}

	ContextDebugf(ctx, "tts.alibaba upstream_ok bytes=%d", len(audio))

	return audio, "audio/mpeg", nil
}

func (s *Server) synthesizeWithDoubao(ctx context.Context, text string) ([]byte, string, error) {
	if s.config.DoubaoTTSAppID == "" || s.config.DoubaoTTSAccessKey == "" || s.config.DoubaoTTSSpeaker == "" {
		return nil, "", newAppError(http.StatusInternalServerError, "语音服务配置不完整，请联系管理员")
	}

	ContextDebugf(
		ctx,
		"tts.doubao upstream=%s speaker=%s format=%s sample_rate=%d",
		logSafeURL(s.config.DoubaoTTSURL),
		s.config.DoubaoTTSSpeaker,
		s.config.DoubaoTTSFormat,
		s.config.DoubaoTTSSampleRate,
	)

	requestBody, err := json.Marshal(map[string]any{
		"user": map[string]any{
			"uid": "tts-" + strconv.FormatInt(time.Now().UnixNano(), 10),
		},
		"req_params": map[string]any{
			"text":    text,
			"speaker": s.config.DoubaoTTSSpeaker,
			"audio_params": map[string]any{
				"format":      s.config.DoubaoTTSFormat,
				"sample_rate": s.config.DoubaoTTSSampleRate,
			},
			"additions": map[string]any{
				"disable_markdown_filter": true,
			},
		},
	})
	if err != nil {
		return nil, "", err
	}

	if strings.TrimSpace(s.config.DoubaoTTSModel) != "" {
		var payload map[string]any
		if err := json.Unmarshal(requestBody, &payload); err != nil {
			return nil, "", err
		}
		payload["req_params"].(map[string]any)["model"] = s.config.DoubaoTTSModel
		requestBody, err = json.Marshal(payload)
		if err != nil {
			return nil, "", err
		}
	}

	response, err := fetchWithTimeout(ctx, s.config.TTSRequestTimeout, func(requestCtx context.Context) (*http.Response, error) {
		request, requestErr := http.NewRequestWithContext(requestCtx, http.MethodPost, s.config.DoubaoTTSURL, bytes.NewReader(requestBody))
		if requestErr != nil {
			return nil, requestErr
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "text/event-stream")
		request.Header.Set("X-Api-App-Id", s.config.DoubaoTTSAppID)
		request.Header.Set("X-Api-Access-Key", s.config.DoubaoTTSAccessKey)
		request.Header.Set("X-Api-Resource-Id", s.config.DoubaoTTSResourceID)
		return s.httpClient.Do(request)
	})
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()

	logID := response.Header.Get("X-Tt-Logid")
	ContextDebugf(ctx, "tts.doubao upstream_response status=%s log_id=%s", response.Status, logID)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", newAppError(
			http.StatusBadGateway,
			"语音合成服务暂时不可用，请稍后重试",
			"豆包 TTS 错误: "+response.Status+" "+safeReadText(cloneResponse(response), 1024)+" logid="+logID,
		)
	}

	audio, err := collectDoubaoAudioFromSSE(response.Body, logID)
	if err != nil {
		return nil, "", err
	}

	ContextDebugf(ctx, "tts.doubao upstream_ok bytes=%d log_id=%s", len(audio), logID)

	return audio, resolveAudioContentType(s.config.DoubaoTTSFormat), nil
}

func collectDoubaoAudioFromSSE(body io.Reader, logID string) ([]byte, error) {
	reader := bufio.NewReader(body)
	var chunks [][]byte
	var currentEvent string
	var currentData []string
	sessionFinished := false

	flush := func() error {
		if currentEvent == "" && len(currentData) == 0 {
			return nil
		}

		rawData := strings.TrimSpace(strings.Join(currentData, "\n"))
		rawEvent := strings.TrimSpace(currentEvent)
		currentEvent = ""
		currentData = nil

		if rawData == "" {
			return nil
		}

		var payload doubaoSSEPayload
		if err := json.Unmarshal([]byte(rawData), &payload); err != nil {
			return newAppError(http.StatusBadGateway, "语音合成服务返回了无法解析的数据", "豆包 SSE 非 JSON 数据: "+truncate(rawData, 200)+" logid="+logID)
		}

		eventCode := parseEventCode(rawEvent, payload.Event)
		switch eventCode {
		case doubaoTTSEventResponse:
			audioData := payload.Data
			if audioData == "" {
				audioData = payload.Audio
			}
			if audioData == "" {
				return nil
			}
			chunk, err := decodeBase64Audio(audioData)
			if err != nil {
				return err
			}
			chunks = append(chunks, chunk)
		case doubaoTTSEventSentenceStart, doubaoTTSEventSentenceEnd:
			return nil
		case doubaoTTSEventSessionFinished:
			if payload.StatusCode != 0 && payload.StatusCode != doubaoSuccessCode {
				return newAppError(http.StatusBadGateway, "语音合成服务暂时不可用，请稍后重试", "豆包 SessionFinished 异常: "+rawData+" logid="+logID)
			}
			sessionFinished = true
		case doubaoTTSEventSessionFailed:
			return newAppError(http.StatusBadGateway, "语音合成服务暂时不可用，请稍后重试", "豆包会话失败: "+rawData+" logid="+logID)
		default:
			if payload.StatusCode != 0 && payload.StatusCode != doubaoSuccessCode {
				return newAppError(http.StatusBadGateway, "语音合成服务暂时不可用，请稍后重试", "豆包会话失败: "+rawData+" logid="+logID)
			}
		}

		return nil
	}

	for {
		line, err := reader.ReadString('\n')
		if err != nil && err != io.EOF {
			return nil, err
		}

		line = strings.TrimSuffix(line, "\n")
		line = strings.TrimSuffix(line, "\r")

		if line == "" {
			if flushErr := flush(); flushErr != nil {
				return nil, flushErr
			}
		} else if strings.HasPrefix(line, "event:") {
			currentEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			currentData = append(currentData, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}

		if err == io.EOF {
			break
		}
	}

	if flushErr := flush(); flushErr != nil {
		return nil, flushErr
	}

	if !sessionFinished && len(chunks) == 0 {
		return nil, newAppError(http.StatusBadGateway, "语音合成服务暂时不可用，请稍后重试", "豆包 SSE 在完成前结束 logid="+logID)
	}

	if len(chunks) == 0 {
		return nil, newAppError(http.StatusBadGateway, "未生成可播放的语音，请稍后重试", "豆包未返回音频片段 logid="+logID)
	}

	return bytes.Join(chunks, nil), nil
}

func resolveAudioContentType(format string) string {
	switch format {
	case "ogg_opus":
		return "audio/ogg"
	case "pcm":
		return "audio/L16"
	default:
		return "audio/mpeg"
	}
}

func parseEventCode(rawEvent string, payloadEvent any) int {
	if rawEvent != "" {
		if value, err := strconv.Atoi(rawEvent); err == nil {
			return value
		}
	}

	switch value := payloadEvent.(type) {
	case float64:
		return int(value)
	case string:
		parsed, err := strconv.Atoi(value)
		if err == nil {
			return parsed
		}
	}

	return 0
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}

	return value[:limit]
}
