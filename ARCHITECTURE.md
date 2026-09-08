# AI Note Taker — Architecture

## Overview

```
┌─────────────────────┐         REST + API key          ┌──────────────────────────┐
│  Chrome Extension   │ ───────────────────────────────▶│  Express server :4000    │
│  (popup / offscreen │   Authorization: Bearer ntk_…   │  ├── EJS web UI          │
│   / background)     │   or X-API-Key: ntk_…           │  ├── /api/* JSON API     │
└─────────────────────┘                                 │  ├── Auth + Users        │
                                                        │  └── MongoDB meetings    │
┌─────────────────────┐         Browser session         │                          │
│  Web (EJS)          │ ───────────────────────────────▶│  Cookie: note_session    │
│  http://localhost:  │   Register / Login / Dashboard  └──────────────────────────┘
│  4000               │
└─────────────────────┘
```

## Principles

1. **Single backend** on port **4000** — API + website (EJS).
2. **Extension is independent** — it does not share cookies; it only needs:
   - Server URL (default `http://localhost:4000`)
   - **API key** (`ntk_…`) from the user’s account page
3. **Web users** log in with username + passkey; session cookie for the browser.
4. **Meetings are scoped** to `userId` of the authenticated account.

## Auth model

| Client | Credential | Header / cookie |
|--------|------------|-----------------|
| Web UI | Session token after login | `Cookie: note_session=…` |
| Extension | Permanent API key | `Authorization: Bearer ntk_…` or `X-API-Key` |

- Register at `/register` → redirects to `/account` with API key.
- Rotate key at `/account` (old key stops working).

## Main routes

### Web (EJS)
- `GET /` — meeting list (auth required)
- `GET|POST /login`, `/register`
- `GET /logout`
- `GET /account` — show / rotate API key
- `GET /meetings/:id` — meeting detail + retry analysis

### API (extension + tools)
- `POST /api/auth/register|login|logout`
- `GET /api/auth/me`
- `POST /api/meetings/complete` — save + Gemini analysis
- `GET /api/meetings`, `GET /api/meetings/:id`, …
- `POST /api/test-gemini`

## Run

```bash
# Server (API + EJS web)
cd server
npm install          # installs ejs, express, mongoose, ...
npm start            # http://localhost:4000

# Extension
cd ..
npm run build
# Load dist/ in chrome://extensions
```

## Extension flow

1. User opens http://localhost:4000/register → creates account.
2. Copies API key from `/account`.
3. Extension popup → paste API key → **Connect**.
4. Record / Save & Analyze → `POST /api/meetings/complete` with API key.
5. View meetings on the web or extension dashboard.

## Folders

```
server/
  server.js       # Express app, Gemini, meeting API, EJS routes
  auth.js         # Users, sessions, API keys
  views/          # EJS templates
  public/         # CSS/JS for web
extension files   # popup, background, offscreen, …
```

The old `client/` on port 3000 is **obsolete**; use the EJS app on **4000**.
