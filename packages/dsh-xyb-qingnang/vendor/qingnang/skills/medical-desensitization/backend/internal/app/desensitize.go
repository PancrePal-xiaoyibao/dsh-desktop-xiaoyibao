package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	defaultMaxDesensitizeBodyBytes int64 = 10 << 20
	defaultMaxDesensitizeFileBytes int64 = 20 << 20
)

var (
	labeledNamePattern      = regexp.MustCompile(`(姓名|患者姓名|患者|就诊人|受检者|检查者|病人)[:：\s]*([\p{Han}·]{2,12})`)
	labeledPhonePattern     = regexp.MustCompile(`(手机号|手机号码|联系电话|电话|本人电话|家属电话|紧急联系人电话)[:：\s]*((?:\+?86[-\s]?)?1[3-9]\d{9})`)
	labeledIDCardPattern    = regexp.MustCompile(`(身份证号|身份证号码|身份证|证件号|证件号码)[:：\s]*([0-9]{17}[0-9Xx])`)
	labeledAddressPattern   = regexp.MustCompile(`(住址|地址|现住址|家庭住址|联系地址)[:：\s]*([^\n]{4,80})`)
	labeledCasePattern      = regexp.MustCompile(`(病案号|门诊号|住院号|就诊卡号|医保号|检查号|报告编号|报告号|申请单号)[:：\s]*([A-Za-z0-9-]{4,32})`)
	labeledBirthPattern     = regexp.MustCompile(`(出生日期|生日)[:：\s]*([0-9]{4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,2}日?)`)
	standalonePhonePattern  = regexp.MustCompile(`(?:\+?86[-\s]?)?1[3-9]\d{9}`)
	standaloneIDCardPattern = regexp.MustCompile(`[0-9]{17}[0-9Xx]`)
	emailPattern            = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
)

type desensitizeRequest struct {
	Text        string       `json:"text"`
	ManualRules []manualRule `json:"manualRules,omitempty"`
}

type desensitizeResponse struct {
	SourceType      string             `json:"sourceType"`
	FileName        string             `json:"fileName,omitempty"`
	OriginalText    string             `json:"originalText"`
	RedactedText    string             `json:"redactedText"`
	Items           []desensitizedItem `json:"items"`
	Summary         desensitizeSummary `json:"summary"`
	Warnings        []string           `json:"warnings,omitempty"`
	UnsupportedFile bool               `json:"unsupportedFile,omitempty"`
}

type desensitizedItem struct {
	Type       string `json:"type"`
	Label      string `json:"label"`
	Original   string `json:"original"`
	Masked     string `json:"masked"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
	Confidence string `json:"confidence"`
}

type desensitizeSummary struct {
	Total           int            `json:"total"`
	CharacterCount  int            `json:"characterCount"`
	RedactedPreview string         `json:"redactedPreview"`
	ByType          map[string]int `json:"byType"`
}

type redactionMatch struct {
	Start      int
	End        int
	Type       string
	Label      string
	Original   string
	Masked     string
	Confidence string
}

type manualRule struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	Label string `json:"label,omitempty"`
}

func (s *Server) handleDesensitize(w http.ResponseWriter, r *http.Request) {
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

	sourceType, fileName, text, manualRules, warnings, unsupported, err := s.parseDesensitizeInput(r)
	if err != nil {
		writeError(r.Context(), w, err)
		return
	}

	text = strings.TrimSpace(text)
	if text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请先粘贴病历文本，或上传可读取文本的文件"})
		return
	}

	items, redactedText := redactMedicalText(text, manualRules)
	byType := make(map[string]int)
	for _, item := range items {
		byType[item.Type]++
	}

	responseItems := make([]desensitizedItem, 0, len(items))
	for _, item := range items {
		responseItems = append(responseItems, desensitizedItem{
			Type:       item.Type,
			Label:      item.Label,
			Original:   item.Original,
			Masked:     item.Masked,
			Start:      item.Start,
			End:        item.End,
			Confidence: item.Confidence,
		})
	}

	writeJSON(w, http.StatusOK, desensitizeResponse{
		SourceType:      sourceType,
		FileName:        fileName,
		OriginalText:    text,
		RedactedText:    redactedText,
		Items:           responseItems,
		Warnings:        warnings,
		UnsupportedFile: unsupported,
		Summary: desensitizeSummary{
			Total:           len(responseItems),
			CharacterCount:  utf8.RuneCountInString(text),
			RedactedPreview: previewText(redactedText, 120),
			ByType:          byType,
		},
	})
}

func (s *Server) parseDesensitizeInput(r *http.Request) (string, string, string, []manualRule, []string, bool, error) {
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(s.maxDesensitizeFileBytes()); err != nil {
			return "", "", "", nil, nil, false, newAppError(http.StatusBadRequest, "上传文件解析失败")
		}

		text := strings.TrimSpace(r.FormValue("text"))
		manualRules, err := parseManualRulesJSON(r.FormValue("manualRules"))
		if err != nil {
			return "", "", "", nil, nil, false, newAppError(http.StatusBadRequest, "手动规则格式不正确")
		}
		file, fileHeader, err := r.FormFile("file")
		if err != nil {
			if text == "" {
				return "", "", "", nil, nil, false, newAppError(http.StatusBadRequest, "未提供可处理内容")
			}
			return "text", "", text, manualRules, nil, false, nil
		}
		defer file.Close()

		fileName := fileHeader.Filename
		mimeType := fileHeader.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = r.Header.Get("X-Test-Content-Type")
		}

		if text != "" {
			warnings := []string{"已优先使用你粘贴的文本内容；上传文件仅作为来源记录。"}
			return "mixed", fileName, text, manualRules, warnings, false, nil
		}

		if isUnsupportedMedicalUpload(fileName, mimeType) {
			return "file", fileName, "", manualRules, []string{"当前版本已接好上传入口，但图片和 PDF 还未接入 OCR，请先粘贴识别后的文本。"}, true, nil
		}

		maxFileBytes := s.maxDesensitizeFileBytes()
		if fileHeader.Size > maxFileBytes {
			return "", "", "", nil, nil, false, newAppError(http.StatusRequestEntityTooLarge, "上传文件过大")
		}

		raw, err := readLimited(file, maxFileBytes)
		if err != nil {
			if err == errContentTooLarge {
				return "", "", "", nil, nil, false, newAppError(http.StatusRequestEntityTooLarge, "上传文件过大")
			}
			return "", "", "", nil, nil, false, newAppError(http.StatusBadRequest, "读取上传文件失败")
		}

		return "file", fileName, string(bytes.TrimSpace(raw)), manualRules, nil, false, nil
	}

	var request desensitizeRequest
	rawBody, err := readLimited(r.Body, s.maxDesensitizeBodyBytes())
	if err != nil {
		if err == errContentTooLarge {
			return "", "", "", nil, nil, false, newAppError(http.StatusRequestEntityTooLarge, "请求内容过大")
		}
		return "", "", "", nil, nil, false, newAppError(http.StatusBadRequest, "读取请求失败")
	}
	if err := json.Unmarshal(rawBody, &request); err != nil {
		return "", "", "", nil, nil, false, newAppError(http.StatusBadRequest, "请求格式不正确")
	}

	return "text", "", request.Text, request.ManualRules, nil, false, nil
}

func (s *Server) maxDesensitizeBodyBytes() int64 {
	if s.config.MaxDesensitizeBodyBytes > 0 {
		return s.config.MaxDesensitizeBodyBytes
	}

	return defaultMaxDesensitizeBodyBytes
}

func (s *Server) maxDesensitizeFileBytes() int64 {
	if s.config.MaxDesensitizeFileBytes > 0 {
		return s.config.MaxDesensitizeFileBytes
	}

	return defaultMaxDesensitizeFileBytes
}

var errContentTooLarge = errors.New("content too large")

func readLimited(reader io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = defaultMaxDesensitizeBodyBytes
	}

	raw, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		return nil, errContentTooLarge
	}

	return raw, nil
}

func isUnsupportedMedicalUpload(fileName string, mimeType string) bool {
	extension := strings.ToLower(filepath.Ext(fileName))
	if extension == ".pdf" || extension == ".png" || extension == ".jpg" || extension == ".jpeg" || extension == ".webp" || extension == ".heic" {
		return true
	}

	normalizedMime := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	if strings.HasPrefix(normalizedMime, "image/") || normalizedMime == "application/pdf" {
		return true
	}

	return false
}

func redactMedicalText(text string, manualRules []manualRule) ([]redactionMatch, string) {
	matches := make([]redactionMatch, 0, 16)
	matches = append(matches, buildManualMatches(text, manualRules)...)
	matches = append(matches, findLabeledMatches(text, labeledNamePattern, "name", "姓名", "[已脱敏姓名]", "high")...)
	matches = append(matches, findLabeledMatches(text, labeledPhonePattern, "phone", "手机号", "[已脱敏手机号]", "high")...)
	matches = append(matches, findLabeledMatches(text, labeledIDCardPattern, "id_card", "身份证号", "[已脱敏身份证号]", "high")...)
	matches = append(matches, findLabeledMatches(text, labeledAddressPattern, "address", "地址", "[已脱敏地址]", "medium")...)
	matches = append(matches, findLabeledMatches(text, labeledCasePattern, "medical_id", "病历编号", "[已脱敏病历编号]", "high")...)
	matches = append(matches, findLabeledMatches(text, labeledBirthPattern, "birth_date", "出生日期", "[已脱敏出生日期]", "medium")...)
	matches = append(matches, findStandaloneMatches(text, standalonePhonePattern, "phone", "手机号", "[已脱敏手机号]", "medium")...)
	matches = append(matches, findStandaloneMatches(text, standaloneIDCardPattern, "id_card", "身份证号", "[已脱敏身份证号]", "medium")...)
	matches = append(matches, findStandaloneMatches(text, emailPattern, "email", "邮箱", "[已脱敏邮箱]", "medium")...)

	selected := compactMatches(matches)
	if len(selected) == 0 {
		return nil, text
	}

	var builder strings.Builder
	builder.Grow(len(text))
	last := 0
	for _, match := range selected {
		builder.WriteString(text[last:match.Start])
		builder.WriteString(match.Masked)
		last = match.End
	}
	builder.WriteString(text[last:])

	return selected, builder.String()
}

func buildManualMatches(text string, manualRules []manualRule) []redactionMatch {
	if len(manualRules) == 0 {
		return nil
	}

	matches := make([]redactionMatch, 0, len(manualRules))
	seen := make(map[string]struct{})
	for _, rule := range manualRules {
		ruleText := strings.TrimSpace(rule.Text)
		if ruleText == "" {
			continue
		}

		ruleType := normalizeManualRuleType(rule.Type)
		label, masked := manualRuleMetadata(ruleType, rule.Label)
		searchStart := 0
		for {
			index := strings.Index(text[searchStart:], ruleText)
			if index < 0 {
				break
			}

			start := searchStart + index
			end := start + len(ruleText)
			key := ruleType + ":" + strconv.Itoa(start) + ":" + strconv.Itoa(end)
			if _, ok := seen[key]; !ok {
				matches = append(matches, redactionMatch{
					Start:      start,
					End:        end,
					Type:       ruleType,
					Label:      label,
					Original:   text[start:end],
					Masked:     masked,
					Confidence: "manual",
				})
				seen[key] = struct{}{}
			}

			searchStart = end
		}
	}

	return matches
}

func parseManualRulesJSON(raw string) ([]manualRule, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	var rules []manualRule
	if err := json.Unmarshal([]byte(raw), &rules); err != nil {
		return nil, err
	}

	return rules, nil
}

func normalizeManualRuleType(value string) string {
	switch strings.TrimSpace(value) {
	case "name", "phone", "id_card", "address", "medical_id", "birth_date", "email":
		return value
	default:
		return "custom"
	}
}

func manualRuleMetadata(ruleType string, customLabel string) (string, string) {
	switch ruleType {
	case "name":
		return "姓名", "[手动脱敏姓名]"
	case "phone":
		return "手机号", "[手动脱敏手机号]"
	case "id_card":
		return "身份证号", "[手动脱敏身份证号]"
	case "address":
		return "地址", "[手动脱敏地址]"
	case "medical_id":
		return "病历编号", "[手动脱敏病历编号]"
	case "birth_date":
		return "出生日期", "[手动脱敏出生日期]"
	case "email":
		return "邮箱", "[手动脱敏邮箱]"
	default:
		label := strings.TrimSpace(customLabel)
		if label == "" {
			label = "自定义规则"
		}
		return label, "[手动脱敏内容]"
	}
}

func findLabeledMatches(text string, pattern *regexp.Regexp, itemType string, label string, replacement string, confidence string) []redactionMatch {
	indexes := pattern.FindAllStringSubmatchIndex(text, -1)
	matches := make([]redactionMatch, 0, len(indexes))
	for _, index := range indexes {
		if len(index) < 6 {
			continue
		}

		valueStart, valueEnd := index[4], index[5]
		if valueStart < 0 || valueEnd <= valueStart {
			continue
		}

		matches = append(matches, redactionMatch{
			Start:      valueStart,
			End:        valueEnd,
			Type:       itemType,
			Label:      label,
			Original:   text[valueStart:valueEnd],
			Masked:     replacement,
			Confidence: confidence,
		})
	}
	return matches
}

func findStandaloneMatches(text string, pattern *regexp.Regexp, itemType string, label string, replacement string, confidence string) []redactionMatch {
	indexes := pattern.FindAllStringIndex(text, -1)
	matches := make([]redactionMatch, 0, len(indexes))
	for _, index := range indexes {
		if len(index) < 2 {
			continue
		}

		start, end := index[0], index[1]
		matches = append(matches, redactionMatch{
			Start:      start,
			End:        end,
			Type:       itemType,
			Label:      label,
			Original:   text[start:end],
			Masked:     replacement,
			Confidence: confidence,
		})
	}
	return matches
}

func compactMatches(matches []redactionMatch) []redactionMatch {
	if len(matches) == 0 {
		return nil
	}

	sort.Slice(matches, func(i, j int) bool {
		if matches[i].Start != matches[j].Start {
			return matches[i].Start < matches[j].Start
		}

		return (matches[i].End - matches[i].Start) > (matches[j].End - matches[j].Start)
	})

	selected := make([]redactionMatch, 0, len(matches))
	currentEnd := -1
	for _, match := range matches {
		if match.Start < currentEnd {
			continue
		}

		selected = append(selected, match)
		currentEnd = match.End
	}

	return selected
}

func previewText(text string, maxRunes int) string {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) <= maxRunes {
		return text
	}

	runes := []rune(text)
	return string(runes[:maxRunes]) + "..."
}

func normalizedFileTypeLabel(fileName string) string {
	extension := strings.ToLower(filepath.Ext(fileName))
	if extension == "" {
		return "未知文件"
	}

	return strings.TrimPrefix(extension, ".")
}

func detectedMimeCategory(fileName string, mimeType string) string {
	normalizedMime := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	if normalizedMime != "" {
		if mediaType, _, err := mime.ParseMediaType(normalizedMime); err == nil {
			return mediaType
		}
	}

	return normalizedFileTypeLabel(fileName)
}
