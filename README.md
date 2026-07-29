# Deepgram Voice Notes – Chrome Extension (Manifest V3)

Production-ready real-time voice notes extension that streams microphone audio to Deepgram’s Live Transcription (Streaming) API.

## Architecture

| Component            | Role |
|----------------------|------|
| **background.js**    | Service worker – owns recording state, creates/closes the offscreen document, relays messages, persists data in `chrome.storage.local`. |
| **offscreen.html/js**| Hidden DOM document (reason: `USER_MEDIA`) – owns `getUserMedia`, `MediaRecorder` (250 ms WebM/Opus chunks), and the Deepgram WebSocket. |
| **popup.html/js/css**| UI – live transcript, Start / Stop / Pause / Resume / New Note / Clear / Copy / Download, word & character counts. |
| **options.html/js/css** | Stores the user’s Deepgram API key (never hardcoded). |
| **storage.js**       | Shared async helpers for `chrome.storage.local`. |

## Deepgram Protocol (official)

- **Endpoint**: `wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&punctuate=true&interim_results=true&smart_format=true&endpointing=300`
- **Browser auth**: WebSocket subprotocol `['token', '<API_KEY>']` (maps to `Sec-WebSocket-Protocol`)
- **Audio**: Binary WebM/Opus frames sent every 250 ms via `MediaRecorder.start(250)`
- **Control messages**:
  - `{ "type": "KeepAlive" }` – sent while paused (prevents ~10 s silence timeout)
  - `{ "type": "CloseStream" }` – graceful shutdown
- **Results**: JSON messages of type `Results` with `is_final` / `speech_final` and `channel.alternatives[0].transcript`

Reference: [Deepgram Live Audio docs](https://developers.deepgram.com/reference/speech-to-text/listen-streaming) and [Sec-WebSocket-Protocol guide](https://developers.deepgram.com/docs/using-the-sec-websocket-protocol).

## Installation (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open the extension’s **Options** page and paste your Deepgram API key
5. Click the extension icon → **Start**

## File list

```
manifest.json
storage.js
background.js
offscreen.html
offscreen.js
popup.html
popup.css
popup.js
options.html
options.css
options.js
icons/icon16.png
icons/icon32.png
icons/icon48.png
icons/icon128.png
README.md
```

## Console debugging

Every file emits detailed `[filename]`-prefixed logs so you can follow the full lifecycle in the service-worker console, offscreen console, and popup console.
