# Security note

This distribution intentionally does not include local `.env` files or embedded provider credentials.

Before building the extension for local use, copy `.env.example` to `.env` and add the **rotated** provider credentials. Do not commit `.env` or distribute generated `dist/runtime-config.js` / `dist/background.js` files containing real provider keys.

The Account & Settings page masks the extension API key by default. Use **Show** or **Copy** only when connecting the extension, and use **Rotate key** if the previous credential was exposed.
