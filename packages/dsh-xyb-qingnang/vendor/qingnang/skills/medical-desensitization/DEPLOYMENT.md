# Public deployment checklist

This project can be deployed as a single Docker web service. The current `render.yaml` targets Render, but the same Dockerfile can be used on other container platforms.

## 1. Merge through a protected branch

Before deploying from `main`, enable the `main` branch ruleset described in [`.github/BRANCH_PROTECTION.md`](./.github/BRANCH_PROTECTION.md), then merge changes through a pull request.

## 2. Create the Render service

1. Open Render.
2. Create a new Blueprint or Web Service from this GitHub repository.
3. Select the `main` branch after the hardening PR is merged.
4. Keep runtime as Docker.
5. Keep health check path as `/healthz`.

The service exposes one public URL. Nginx serves the frontend and proxies `/api/*`, `/api/stt/ws`, and `/healthz` to the Go backend.

For normal login and cross-browser history, configure persistent storage for `DATA_DIR`. On Render, attach a persistent disk and set:

```env
DATA_DIR=/var/data
```

Without persistent storage, accounts and history can be lost when the service is rebuilt or moved.

## 3. Required environment variables

The safe defaults in `render.yaml` are enough for text desensitization demos:

```env
LOG_LEVEL=log
MAX_DESENSITIZE_BODY_BYTES=10485760
MAX_DESENSITIZE_FILE_BYTES=20971520
NGINX_CLIENT_MAX_BODY_SIZE=20m
NEXT_PUBLIC_AI_CHAT_ENABLED=false
```

After Render gives you the public service URL, add it to backend CORS settings:

```env
CORS_ALLOWED_ORIGINS=https://your-service.onrender.com
```

This is especially important for WebSocket features such as streaming STT.

## 4. Optional AI and speech variables

Only add these when you are ready to use AI chat, STT, or TTS. Store them as Render environment variables or secrets, never in the repository.

```env
CHAT_PROVIDER=fastgpt
CHAT_API_URL=https://your-fastgpt-host/api/v1/chat/completions
CHAT_API_KEY=...
CHAT_REQUEST_TIMEOUT_MS=300000
FASTGPT_STREAM_DETAIL=false

STT_PROVIDER=doubao
TTS_PROVIDER=doubao
DOUBAO_STT_APP_ID=...
DOUBAO_STT_ACCESS_KEY=...
DOUBAO_TTS_APP_ID=...
DOUBAO_TTS_ACCESS_KEY=...
DOUBAO_TTS_SPEAKER=...
```

If `NEXT_PUBLIC_AI_CHAT_ENABLED=true` is needed, set it before building or trigger a redeploy after changing it because `NEXT_PUBLIC_*` values are embedded into the Next.js build.

## 5. First public smoke test

After deployment:

1. Open the Render URL.
2. Visit `/healthz` and confirm it returns JSON with `"status":"ok"`.
3. Paste sample text such as `姓名：张三 手机号：13812345678 身份证号：110101199003076612`.
4. Run desensitization and confirm sensitive fields are masked.
5. Upload a small text file and confirm it is processed.
6. Do not use real patient records until logging, third-party provider use, access control, and data retention are approved.
