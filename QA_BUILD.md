# QA extension build

The extension is built from environment configuration. Do not manually edit `dist/`.

## Local development

```bash
npm run build:dev
```

Uses `.env` and defaults to the local backend (`http://localhost:4000`).

## QA / LAN

Create `.env.qa` from `.env.qa.example`:

```env
BACKEND_URL=http://192.168.1.5:4000
CLIENT_URL=http://192.168.1.5:3000
```

Then run:

```bash
npm run build:qa
```

This regenerates `dist/` and automatically adds the configured backend origin to `host_permissions` in `dist/manifest.json`.

Give QA the generated `dist/` directory and have them load it through Chrome → Extensions → Developer mode → Load unpacked.

The server itself must listen on `0.0.0.0:4000`, and Windows Firewall must allow TCP 4000.

Never commit or share `.env.qa` if it contains provider API keys. Share only the generated extension with QA, and keep secrets out of source control.
