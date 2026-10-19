package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

type chatRequest struct {
	Messages           []map[string]any `json:"messages"`
	Stream             *bool            `json:"stream,omitempty"`
	ChatID             string           `json:"chatId,omitempty"`
	ResponseChatItemID string           `json:"responseChatItemId,omitempty"`
	Detail             *bool            `json:"detail,omitempty"`
	Variables          map[string]any   `json:"variables,omitempty"`
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if s.config.ChatAPIURL == "" || s.config.ChatAPIKey == "" {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "服务端配置不完整，请联系管理员"})
		return
	}

	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求格式不正确"})
		return
	}

	if len(body.Messages) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求格式不正确"})
		return
	}

	stream := true
	if body.Stream != nil {
		stream = *body.Stream
	}

	ContextDebugf(
		r.Context(),
		"chat.request provider=%s stream=%t messages=%d chat_id=%q response_chat_item_id=%q variables=%d",
		s.config.ChatProvider,
		stream,
		len(body.Messages),
		truncate(body.ChatID, 80),
		truncate(body.ResponseChatItemID, 80),
		len(body.Variables),
	)

	requestBody, err := json.Marshal(s.buildChatUpstreamPayload(body, stream))
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	ContextDebugf(r.Context(), "chat.upstream_request url=%s timeout=%s", logSafeURL(s.config.ChatAPIURL), s.config.ChatRequestTimeout)
	response, err := fetchWithTimeout(r.Context(), s.config.ChatRequestTimeout, func(ctx context.Context) (*http.Response, error) {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, s.config.ChatAPIURL, bytes.NewReader(requestBody))
		if requestErr != nil {
			return nil, requestErr
		}
		request.Header.Set("Content-Type", "application/json")
		if stream {
			request.Header.Set("Accept", "text/event-stream")
		}
		request.Header.Set("Authorization", "Bearer "+s.config.ChatAPIKey)
		return s.httpClient.Do(request)
	})
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}
	defer response.Body.Close()

	ContextDebugf(
		r.Context(),
		"chat.upstream_response status=%s content_type=%q",
		response.Status,
		response.Header.Get("Content-Type"),
	)

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(r.Context(), w, newAppError(
			http.StatusBadGateway,
			"对话服务暂时不可用，请稍后重试",
			"聊天上游错误: "+response.Status+" "+safeReadText(cloneResponse(response), 1024),
		))
		return
	}

	if stream {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		if err := streamResponse(w, response.Body); err != nil {
			ContextDebugf(r.Context(), "chat.stream_interrupted error=%v", err)
			return
		}
		ContextDebugf(r.Context(), "chat.stream_completed provider=%s", s.config.ChatProvider)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, response.Body)
}

func (s *Server) buildChatUpstreamPayload(body chatRequest, stream bool) map[string]any {
	messages := body.Messages
	payload := map[string]any{
		"messages": messages,
		"stream":   stream,
	}
	if strings.TrimSpace(s.config.ChatModel) != "" {
		payload["model"] = s.config.ChatModel
	}

	if s.config.ChatProvider != "fastgpt" {
		return payload
	}

	if chatID := strings.TrimSpace(body.ChatID); chatID != "" {
		payload["chatId"] = chatID
		payload["messages"] = lastChatMessage(messages)
	}

	if responseChatItemID := strings.TrimSpace(body.ResponseChatItemID); responseChatItemID != "" {
		payload["responseChatItemId"] = responseChatItemID
	}

	detail := s.config.FastGPTStreamDetail
	if body.Detail != nil {
		detail = *body.Detail
	}
	payload["detail"] = detail

	if len(body.Variables) > 0 {
		payload["variables"] = body.Variables
	}

	return payload
}

func lastChatMessage(messages []map[string]any) []map[string]any {
	if len(messages) == 0 {
		return messages
	}

	return []map[string]any{messages[len(messages)-1]}
}

func streamResponse(w http.ResponseWriter, body io.Reader) error {
	flusher, _ := w.(http.Flusher)
	reader := bufio.NewReader(body)
	buffer := make([]byte, 4096)

	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}

		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func cloneResponse(response *http.Response) *http.Response {
	if response == nil || response.Body == nil {
		return response
	}

	var cancel func()
	if wrapped, ok := response.Body.(*cancelOnCloseReadCloser); ok {
		cancel = wrapped.cancel
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return response
	}

	response.Body = io.NopCloser(bytes.NewReader(body))
	if cancel != nil {
		response.Body = &cancelOnCloseReadCloser{
			ReadCloser: response.Body,
			cancel:     cancel,
		}
	}
	cloned := *response
	cloned.Body = io.NopCloser(bytes.NewReader(body))
	return &cloned
}
