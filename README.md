# AI Note Taker — Chrome Extension

A professional Manifest V3 Chrome extension for live meeting transcription. API credentials are **developer-managed** through `.env`; end users are never asked to paste an API key.

## Supported transcription providers

| Provider | Mode | Config |
|---|---|---|
| AssemblyAI | Live WebSocket streaming | `ASSEMBLYAI_API_KEY` |
| Deepgram | Live WebSocket streaming | `DEEPGRAM_API_KEY` |
| OpenAI | Near-live 4-second audio segments | `OPENAI_API_KEY` |

The app uses `TRANSCRIBE_PROVIDER` first. If that provider is not configured or cannot connect, it tries the providers listed in `TRANSCRIBE_FALLBACKS`.

AssemblyAI Streaming v3 currently uses `wss://streaming.assemblyai.com/v3/ws`, PCM16 mono audio, and supports partial/final `Turn` messages. Deepgram's live Listen API uses its WebSocket endpoint and supports browser authentication through the WebSocket subprotocol. The implementation follows those current protocols.

## Developer setup

1. Install Node.js.
2. Copy `.env.example` to `.env`.
3. Put the provider credentials in `.env`:

```env
TRANSCRIBE_PROVIDER=assemblyai
TRANSCRIBE_FALLBACKS=deepgram,assemblyai,openai

DEEPGRAM_API_KEY=
ASSEMBLYAI_API_KEY=
OPENAI_API_KEY=
```

4. Build:

```bash
npm run build
```

5. Open `chrome://extensions`.
6. Enable **Developer mode**.
7. Click **Load unpacked**.
8. Select the generated `dist` folder.

When you change `.env`, run `npm run build` again and reload the extension.

## Important security note

A `.env` file is a developer/build-time mechanism. Chrome extensions cannot directly read `process.env`. The build script reads `.env` and generates `dist/runtime-config.js`.

That means a key embedded into a client-side extension can ultimately be inspected by someone who has the extension package. This is acceptable for a controlled/internal developer build when you explicitly want developer-managed credentials, but it is **not a secure way to distribute a public extension with valuable long-lived API keys**.

For a public production product, use a small backend to keep provider keys server-side and mint short-lived browser tokens. AssemblyAI explicitly recommends temporary tokens for browser/mobile streaming, and OpenAI recommends keeping standard API keys server-side.

## Architecture

```text
Popup
  │
  ├── microphone permission
  │
  ▼
Background Service Worker
  │
  ▼
Offscreen Document
  │
  ├── Deepgram → WebM/Opus WebSocket
  │
  ├── AssemblyAI → PCM16 16kHz WebSocket
  │
  └── OpenAI → PCM/WAV 4-second transcription segments
  │
  ▼
Normalized transcript events
  │
  ▼
chrome.storage.local
  │
  ▼
Professional popup UI
```

## Project files

- `popup.*` — modern recording/transcript interface
- `background.js` — extension orchestration and state
- `offscreen.js` — microphone + provider adapters
- `audio-processor.js` — low-level PCM capture for providers requiring raw audio
- `storage.js` — local state
- `options.*` — developer/provider status page
- `build.mjs` — `.env` → runtime configuration build step
- `.env` — developer secrets, ignored by git
- `dist/` — load this folder into Chrome after building

## Current behavior

- No API-key form is shown to users.
- Active provider is selected by `.env`.
- Configured fallback providers are tried automatically.
- AssemblyAI and Deepgram provide true live streaming.
- OpenAI is implemented as a near-live fallback because the standard audio transcription endpoint is segment/file based; it is not presented as a fake sub-250ms streaming provider.
- Transcript text remains editable and is stored locally.
- Start / Stop / Pause / Resume / New / Clear / Copy / Export are supported.

## Troubleshooting

If the extension reports no configured provider:

- Check `.env`.
- Ensure the variable names are exactly correct.
- Run `npm run build`.
- Reload `dist` from `chrome://extensions`.

If microphone access fails, allow microphone permission for the extension and retry.

If AssemblyAI is selected, the extension mints a short-lived streaming token using the developer API key before opening the browser WebSocket. This avoids putting the long-lived key in the WebSocket URL.

References:
- Deepgram live streaming: https://developers.deepgram.com/docs/live-streaming-audio
- Deepgram browser WebSocket auth: https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
- AssemblyAI streaming: https://www.assemblyai.com/docs/streaming
- AssemblyAI browser token guidance: https://www.assemblyai.com/docs/streaming
- OpenAI API key security: https://platform.openai.com/docs/api-reference/authentication

## Automatic meeting detection

The extension automatically detects supported meeting URLs in the active tab for Google Meet, Zoom, and Microsoft Teams. When a meeting is detected, it opens the extension action popup (Chrome 127+) and shows a **Meeting detected** banner. The user must click **Start recording** before microphone permission is requested and transcription begins.

Manual recording is always available from the extension popup even when no meeting is open.

The extension does not ask users for provider API keys; provider credentials remain developer-only in `.env`.


## v5 recording stability fix

AssemblyAI receives 16 kHz mono PCM16 in buffered 100 ms frames. The browser AudioWorklet emits much smaller callbacks, so v5 batches them before sending. This prevents the streaming session from being rejected/closed because of undersized audio frames.


### Precise meeting detection (v8)

The detector does not treat generic platform landing pages such as `https://meet.google.com/home` as meetings. Google Meet requires a meeting-code URL such as `https://meet.google.com/abc-defg-hij`. Zoom requires a join-style URL such as `/j/<meeting-number>`, and Microsoft Teams requires a `/l/meetup-join/` URL. The extension only opens the AI Note Taker popup when a meeting URL is detected; it never starts recording automatically. The user must click Start recording.


## v2.0.2 — Automatic meeting transcription

When a qualifying Google Meet, Zoom, or Microsoft Teams meeting URL is detected, the background service attempts to start transcription immediately. If microphone permission has already been granted, recording starts automatically. On first use, Chrome may require the user to approve microphone access; the extension opens its normal popup with the Start recording action so the user can complete the permission flow.

Meeting landing pages such as `meet.google.com/home` do not trigger recording.
