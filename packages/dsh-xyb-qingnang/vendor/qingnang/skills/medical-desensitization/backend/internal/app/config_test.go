package app

import "testing"

func TestLoadConfig_DesensitizeLimitsFromEnv(t *testing.T) {
	t.Setenv("MAX_DESENSITIZE_BODY_BYTES", "12345")
	t.Setenv("MAX_DESENSITIZE_FILE_BYTES", "67890")

	config := LoadConfig()

	if config.MaxDesensitizeBodyBytes != 12345 {
		t.Fatalf("MaxDesensitizeBodyBytes mismatch: got %d", config.MaxDesensitizeBodyBytes)
	}
	if config.MaxDesensitizeFileBytes != 67890 {
		t.Fatalf("MaxDesensitizeFileBytes mismatch: got %d", config.MaxDesensitizeFileBytes)
	}
}
