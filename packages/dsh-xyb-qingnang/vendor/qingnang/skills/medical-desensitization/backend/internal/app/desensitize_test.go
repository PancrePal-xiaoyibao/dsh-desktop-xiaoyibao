package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestHandleDesensitize_JSONPayload(t *testing.T) {
	backend := newBackendHTTPServer(t, testConfig())
	defer backend.Close()

	requestBody := strings.NewReader(`{"text":"姓名：张三\n手机号：13812345678\n身份证号：110101199003076612\n住址：上海市浦东新区世纪大道100号"}`)
	request, err := http.NewRequest(http.MethodPost, backend.URL+"/api/desensitize", requestBody)
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

	var payload desensitizeResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response failed: %v", err)
	}

	if payload.Summary.Total < 4 {
		t.Fatalf("expected multiple redactions, got %#v", payload.Summary)
	}
	if !strings.Contains(payload.RedactedText, "[已脱敏姓名]") {
		t.Fatalf("expected name marker in redacted text: %s", payload.RedactedText)
	}
	if payload.Summary.ByType["phone"] == 0 {
		t.Fatalf("expected phone item count in summary: %#v", payload.Summary.ByType)
	}
}

func TestHandleDesensitize_MultipartTextFile(t *testing.T) {
	backend := newBackendHTTPServer(t, testConfig())
	defer backend.Close()

	request := createMultipartRequest(
		t,
		backend.URL+"/api/desensitize",
		"report.txt",
		"text/plain",
		[]byte("患者姓名：李四\n病案号：ZY20260089\n邮箱：demo@example.com"),
	)

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}

	var payload desensitizeResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response failed: %v", err)
	}

	if payload.FileName != "report.txt" {
		t.Fatalf("unexpected filename: %s", payload.FileName)
	}
	if payload.Summary.ByType["medical_id"] == 0 {
		t.Fatalf("expected medical id count: %#v", payload.Summary.ByType)
	}
}

func TestHandleDesensitize_UnsupportedUploadNeedsOCRText(t *testing.T) {
	backend := newBackendHTTPServer(t, testConfig())
	defer backend.Close()

	request := createMultipartRequest(
		t,
		backend.URL+"/api/desensitize",
		"record.pdf",
		"application/pdf",
		[]byte("%PDF-1.7"),
	)

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}

	buf := new(bytes.Buffer)
	if _, err := buf.ReadFrom(response.Body); err != nil {
		t.Fatalf("read body failed: %v", err)
	}
	if !strings.Contains(buf.String(), "请先粘贴病历文本") {
		t.Fatalf("unexpected body: %s", buf.String())
	}
}

func TestHandleDesensitize_ManualRules(t *testing.T) {
	backend := newBackendHTTPServer(t, testConfig())
	defer backend.Close()

	requestBody := strings.NewReader(`{"text":"检查结论：联系人王阿姨在场，随访电话请打门口便签上的热线。","manualRules":[{"type":"name","text":"王阿姨"},{"type":"phone","text":"热线"}]}`)
	request, err := http.NewRequest(http.MethodPost, backend.URL+"/api/desensitize", requestBody)
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

	var payload desensitizeResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response failed: %v", err)
	}

	if !strings.Contains(payload.RedactedText, "[手动脱敏姓名]") {
		t.Fatalf("expected manual name marker in redacted text: %s", payload.RedactedText)
	}
	if payload.Summary.ByType["phone"] == 0 {
		t.Fatalf("expected manual phone summary count: %#v", payload.Summary.ByType)
	}
}

func TestHandleDesensitize_RejectsOversizedJSONPayload(t *testing.T) {
	config := testConfig()
	config.MaxDesensitizeBodyBytes = 24
	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	requestBody := strings.NewReader(`{"text":"姓名：张三，手机号：13812345678"}`)
	request, err := http.NewRequest(http.MethodPost, backend.URL+"/api/desensitize", requestBody)
	if err != nil {
		t.Fatalf("create request failed: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://frontend.test")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}
}

func TestHandleDesensitize_RejectsOversizedMultipartFile(t *testing.T) {
	config := testConfig()
	config.MaxDesensitizeFileBytes = 8
	backend := newBackendHTTPServer(t, config)
	defer backend.Close()

	request := createMultipartRequest(
		t,
		backend.URL+"/api/desensitize",
		"report.txt",
		"text/plain",
		[]byte("患者姓名：李四"),
	)

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("perform request failed: %v", err)
	}

	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}
}
