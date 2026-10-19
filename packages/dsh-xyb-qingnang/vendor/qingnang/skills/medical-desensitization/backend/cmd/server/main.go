package main

import (
	"os"

	"xiaoyibao/backend/internal/app"
)

func main() {
	if envFile, err := app.LoadBackendDotEnv(); err != nil {
		app.Errorf("startup env_load_failed error=%v", err)
		os.Exit(1)
	} else if envFile != "" {
		app.Logf("startup env_loaded file=%s", envFile)
	}

	config := app.LoadConfig()
	app.ConfigureLogger(config.LogLevel)
	app.Logf(
		"startup config port=%s chat_provider=%s stt_provider=%s tts_provider=%s log_level=%s",
		config.Port,
		config.ChatProvider,
		config.STTProvider,
		config.TTSProvider,
		config.LogLevel,
	)

	server := app.NewServer(config)
	if err := server.ListenAndServe(); err != nil {
		app.Errorf("startup listen_failed error=%v", err)
		os.Exit(1)
	}
}
