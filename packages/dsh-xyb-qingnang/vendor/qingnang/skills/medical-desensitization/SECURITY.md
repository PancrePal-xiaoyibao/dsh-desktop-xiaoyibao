# Security and privacy notes

This project handles medical records and other sensitive personal data. Treat all pasted text, uploaded files, OCR output, speech transcripts, and AI prompts as private health information.

## Data handling

- The frontend extracts PDF text and image OCR text in the browser before sending text to the Go backend for desensitization.
- The Go backend does not persist original medical text, uploaded file contents, OCR text, or desensitized output by default.
- Login accounts are stored server-side so users can access their own history across browsers. Passwords are stored as salted hashes, never as plaintext.
- AI conversation history may be stored for the logged-in account. Users should send only desensitized content to AI if they want it retained in history.
- Third-party chat, STT, and TTS providers are called only when the related feature is used and configured through backend environment variables.
- Do not enable `LOG_LEVEL=debug` with real patient data unless the deployment logs are access controlled and have a defined retention policy.
- Do not commit `.env`, `.env.local`, `.env.keys`, certificates, recordings, screenshots, exported Markdown, or sample medical records that contain real personal information.

## Dependency advisories

As of 2026-05-06, `npm audit` reports a moderate PostCSS advisory through the current latest `next@16.2.4` dependency chain. Do not run `npm audit fix --force`; npm currently suggests a breaking downgrade path. Keep Dependabot enabled and upgrade Next.js when a non-breaking patched release becomes available.

## Deployment checklist

- Protect the `main` branch before enabling automatic dependency merges.
- Store provider keys only in backend environment variables or deployment secrets.
- Use a persistent `DATA_DIR` in production. On Render, attach a persistent disk or move auth/history storage to a managed database before relying on cross-browser history.
- Set `CORS_ALLOWED_ORIGINS` to the exact production frontend origin.
- Review `MAX_DESENSITIZE_BODY_BYTES` and `MAX_DESENSITIZE_FILE_BYTES` for the expected upload size.
- Confirm whether generated exports should be stored, downloaded, or deleted after use in your operating process.
