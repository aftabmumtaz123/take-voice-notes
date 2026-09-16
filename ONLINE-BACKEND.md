# Online backend configuration

The normal `npm run build` is configured to use:

https://take-voice-notes.vercel.app

Build command:

```bash
npm run build
```

The generated extension build is placed in `build/development/`.

The build script also falls back to the checked-in development build when `dist/`
is not present, so this archive can be built directly after extraction.
