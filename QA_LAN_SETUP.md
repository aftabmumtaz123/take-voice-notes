# QA LAN Setup

## Server
1. Configure `server/.env` with `APP_BASE_URL=http://192.168.1.5:4000`.
2. Start the server normally. It listens on `0.0.0.0:4000`, allowing LAN clients.
3. Allow inbound TCP 4000 in Windows Firewall.
4. From the QA PC open `http://192.168.1.5:4000`.

## Extension
Use the `dist/` folder as the unpacked extension in Chrome. This QA build defaults to `http://192.168.1.5:4000` and includes that origin in `host_permissions`.

If the server URL is changed, reload the extension after rebuilding.

## Connection test
Open the extension and connect with the user's API key. The extension verifies `GET /api/auth/me` against the LAN server. A successful response should show Connected and open the transcription UI.

## Important
Do not send real `.env` files or provider/Gmail secrets to QA.
