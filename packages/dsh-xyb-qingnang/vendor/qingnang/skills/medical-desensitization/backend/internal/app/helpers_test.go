package app

import (
	"strings"
	"testing"
)

func TestCleanTTSText_StripsMarkdownArtifacts(t *testing.T) {
	input := "# 标题\n1. [帮助链接](https://example.com)\n`内联代码`\n![图片](https://img)\n```ts\nconsole.log('x')\n```\n正文"

	cleaned := cleanTTSText(input)

	for _, unexpected := range []string{"#", "```", "https://example.com", "![", "1."} {
		if strings.Contains(cleaned, unexpected) {
			t.Fatalf("cleaned text still contains %q: %q", unexpected, cleaned)
		}
	}

	for _, expected := range []string{"标题", "帮助链接", "内联代码", "正文"} {
		if !strings.Contains(cleaned, expected) {
			t.Fatalf("cleaned text missing %q: %q", expected, cleaned)
		}
	}
}

func TestCollectDoubaoAudioFromSSE_DecodesAudio(t *testing.T) {
	body := strings.NewReader(
		"event: 352\n" +
			"data: {\"data\":\"aGVsbG8=\"}\n\n" +
			"event: 152\n" +
			"data: {\"status_code\":20000000}\n\n",
	)

	audio, err := collectDoubaoAudioFromSSE(body, "log-test")
	if err != nil {
		t.Fatalf("collectDoubaoAudioFromSSE returned error: %v", err)
	}

	if got, want := string(audio), "hello"; got != want {
		t.Fatalf("audio mismatch: got %q want %q", got, want)
	}
}

func TestParseWAVPCM_ExtractsPCMData(t *testing.T) {
	samples := []int16{1, -2, 3, -4}
	wav := createTestWAV(16_000, 1, samples)

	pcm, err := parseWAVPCM(wav)
	if err != nil {
		t.Fatalf("parseWAVPCM returned error: %v", err)
	}

	if got, want := len(pcm), len(samples)*2; got != want {
		t.Fatalf("pcm length mismatch: got %d want %d", got, want)
	}
}

func TestParseWAVPCM_RejectsUnexpectedSampleRate(t *testing.T) {
	wav := createTestWAV(44_100, 1, []int16{1, 2, 3, 4})

	_, err := parseWAVPCM(wav)
	if err == nil {
		t.Fatal("expected parseWAVPCM to reject unsupported sample rate")
	}

	if !strings.Contains(err.Error(), "16kHz") {
		t.Fatalf("unexpected error: %v", err)
	}
}
