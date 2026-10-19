package app

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port string

	CORSAllowedOrigins      []string
	DataDir                 string
	MaxDesensitizeBodyBytes int64
	MaxDesensitizeFileBytes int64

	LogLevel            string
	ChatProvider        string
	ChatAPIURL          string
	ChatAPIKey          string
	ChatModel           string
	ChatAPIResolvedIP   string
	ChatRequestTimeout  time.Duration
	FastGPTStreamDetail bool

	STTProvider                string
	TTSProvider                string
	STTRequestTimeout          time.Duration
	TTSRequestTimeout          time.Duration
	AlibabaAPIKey              string
	AlibabaBaseURL             string
	AlibabaSTTModel            string
	AlibabaTTSModel            string
	AlibabaTTSVoice            string
	DoubaoSTTURL               string
	DoubaoSTTAppID             string
	DoubaoSTTAccessKey         string
	DoubaoSTTResourceID        string
	DoubaoSTTModelName         string
	DoubaoSTTLanguage          string
	DoubaoSTTEnableITN         bool
	DoubaoSTTEnablePunc        bool
	DoubaoSTTEnableDDC         bool
	DoubaoSTTEnableNonstream   bool
	DoubaoSTTShowUtterances    bool
	DoubaoSTTResultType        string
	DoubaoSTTEndWindowSize     int
	DoubaoSTTForceToSpeechTime int
	DoubaoTTSURL               string
	DoubaoTTSAppID             string
	DoubaoTTSAccessKey         string
	DoubaoTTSResourceID        string
	DoubaoTTSSpeaker           string
	DoubaoTTSModel             string
	DoubaoTTSFormat            string
	DoubaoTTSSampleRate        int
}

func LoadConfig() Config {
	return Config{
		Port:                       getenv("BACKEND_PORT", "8080"),
		CORSAllowedOrigins:         parseOrigins(os.Getenv("CORS_ALLOWED_ORIGINS")),
		DataDir:                    getenv("DATA_DIR", "backend/data"),
		MaxDesensitizeBodyBytes:    int64(parsePositiveInt(os.Getenv("MAX_DESENSITIZE_BODY_BYTES"), 10<<20)),
		MaxDesensitizeFileBytes:    int64(parsePositiveInt(os.Getenv("MAX_DESENSITIZE_FILE_BYTES"), 20<<20)),
		LogLevel:                   normalizeLogLevel(os.Getenv("LOG_LEVEL")),
		ChatProvider:               normalizeChatProvider(os.Getenv("CHAT_PROVIDER")),
		ChatAPIURL:                 os.Getenv("CHAT_API_URL"),
		ChatAPIKey:                 os.Getenv("CHAT_API_KEY"),
		ChatModel:                  getenv("CHAT_MODEL", "sf-glm-4.5-air"),
		ChatAPIResolvedIP:          strings.TrimSpace(os.Getenv("CHAT_API_RESOLVED_IP")),
		ChatRequestTimeout:         time.Duration(parsePositiveInt(os.Getenv("CHAT_REQUEST_TIMEOUT_MS"), 300_000)) * time.Millisecond,
		FastGPTStreamDetail:        parseBool(os.Getenv("FASTGPT_STREAM_DETAIL"), false),
		STTProvider:                normalizeProvider(os.Getenv("STT_PROVIDER")),
		TTSProvider:                normalizeProvider(os.Getenv("TTS_PROVIDER")),
		STTRequestTimeout:          time.Duration(parsePositiveInt(os.Getenv("STT_REQUEST_TIMEOUT_MS"), 45_000)) * time.Millisecond,
		TTSRequestTimeout:          time.Duration(parsePositiveInt(os.Getenv("TTS_FETCH_TIMEOUT_MS"), 45_000)) * time.Millisecond,
		AlibabaAPIKey:              os.Getenv("ALIBABA_API_KEY"),
		AlibabaBaseURL:             strings.TrimRight(os.Getenv("ALIBABA_BASE_URL"), "/"),
		AlibabaSTTModel:            getenv("ALIBABA_STT_MODEL", "paraformer-v1"),
		AlibabaTTSModel:            getenv("ALIBABA_TTS_MODEL", "qwen3-tts-flash"),
		AlibabaTTSVoice:            getenv("ALIBABA_TTS_VOICE", "loongbella"),
		DoubaoSTTURL:               getenv("DOUBAO_STT_URL", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"),
		DoubaoSTTAppID:             os.Getenv("DOUBAO_STT_APP_ID"),
		DoubaoSTTAccessKey:         os.Getenv("DOUBAO_STT_ACCESS_KEY"),
		DoubaoSTTResourceID:        getenv("DOUBAO_STT_RESOURCE_ID", "volc.seedasr.sauc.duration"),
		DoubaoSTTModelName:         getenv("DOUBAO_STT_MODEL_NAME", "bigmodel"),
		DoubaoSTTLanguage:          getenv("DOUBAO_STT_LANGUAGE", "zh-CN"),
		DoubaoSTTEnableITN:         parseBool(os.Getenv("DOUBAO_STT_ENABLE_ITN"), true),
		DoubaoSTTEnablePunc:        parseBool(os.Getenv("DOUBAO_STT_ENABLE_PUNC"), true),
		DoubaoSTTEnableDDC:         parseBool(os.Getenv("DOUBAO_STT_ENABLE_DDC"), false),
		DoubaoSTTEnableNonstream:   parseBool(os.Getenv("DOUBAO_STT_ENABLE_NONSTREAM"), true),
		DoubaoSTTShowUtterances:    parseBool(os.Getenv("DOUBAO_STT_SHOW_UTTERANCES"), true),
		DoubaoSTTResultType:        normalizeResultType(os.Getenv("DOUBAO_STT_RESULT_TYPE")),
		DoubaoSTTEndWindowSize:     parsePositiveInt(os.Getenv("DOUBAO_STT_END_WINDOW_SIZE"), 800),
		DoubaoSTTForceToSpeechTime: parsePositiveInt(os.Getenv("DOUBAO_STT_FORCE_TO_SPEECH_TIME"), 1_000),
		DoubaoTTSURL:               getenv("DOUBAO_TTS_URL", "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"),
		DoubaoTTSAppID:             os.Getenv("DOUBAO_TTS_APP_ID"),
		DoubaoTTSAccessKey:         os.Getenv("DOUBAO_TTS_ACCESS_KEY"),
		DoubaoTTSResourceID:        getenv("DOUBAO_TTS_RESOURCE_ID", "seed-tts-2.0"),
		DoubaoTTSSpeaker:           os.Getenv("DOUBAO_TTS_SPEAKER"),
		DoubaoTTSModel:             os.Getenv("DOUBAO_TTS_MODEL"),
		DoubaoTTSFormat:            getenv("DOUBAO_TTS_FORMAT", "mp3"),
		DoubaoTTSSampleRate:        normalizeSampleRate(os.Getenv("DOUBAO_TTS_SAMPLE_RATE")),
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}

	return fallback
}

func parseOrigins(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{
			"http://localhost:3000",
			"http://127.0.0.1:3000",
			"https://localhost:3000",
			"https://127.0.0.1:3000",
		}
	}

	parts := strings.Split(value, ",")
	origins := make([]string, 0, len(parts))
	for _, part := range parts {
		origin := strings.TrimSpace(part)
		if origin != "" {
			origins = append(origins, origin)
		}
	}

	return origins
}

func parsePositiveInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return fallback
	}

	return parsed
}

func parseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

func normalizeProvider(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "doubao") {
		return "doubao"
	}

	return "alibaba"
}

func normalizeChatProvider(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "fastgpt") {
		return "fastgpt"
	}

	return "openai"
}

func normalizeLogLevel(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "debug") {
		return "debug"
	}

	return "log"
}

func normalizeResultType(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "single") {
		return "single"
	}

	return "full"
}

func normalizeSampleRate(value string) int {
	allowed := map[int]struct{}{
		8000: {}, 16000: {}, 22050: {}, 24000: {}, 32000: {}, 44100: {}, 48000: {},
	}
	parsed := parsePositiveInt(value, 24_000)
	if _, ok := allowed[parsed]; !ok {
		return 24_000
	}

	return parsed
}
