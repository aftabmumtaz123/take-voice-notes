import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const args = process.argv.slice(2);
const envArg = args.find((arg) => arg.startsWith('--env='));
const buildEnv = (envArg ? envArg.slice('--env='.length) : 'development').trim().toLowerCase() || 'development';
const envCandidates = buildEnv === 'qa'
  ? [path.join(root, '.env.qa'), path.join(root, '.env')]
  : [path.join(root, '.env')];
const envPath = envCandidates.find((candidate) => fs.existsSync(candidate));

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

if (!envPath) {
  throw new Error(`No environment file found for '${buildEnv}'. Copy .env.example to .env${buildEnv === 'qa' ? ' or create .env.qa' : ''} and configure the developer keys.`);
}

const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
const active = (env.TRANSCRIBE_PROVIDER || 'assemblyai').toLowerCase();
const fallback = (env.TRANSCRIBE_FALLBACKS || 'deepgram,assemblyai,openai')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

const valid = new Set(['deepgram', 'assemblyai', 'openai']);
if (!valid.has(active)) throw new Error(`Invalid TRANSCRIBE_PROVIDER: ${active}`);

const config = {
  activeProvider: active,
  fallbackProviders: [...new Set([active, ...fallback])].filter(p => valid.has(p)),
  keys: {
    deepgram: env.DEEPGRAM_API_KEY || '',
    assemblyai: env.ASSEMBLYAI_API_KEY || '',
    openai: env.OPENAI_API_KEY || ''
  },
  deepgramModel: env.DEEPGRAM_MODEL || 'nova-3',
  assemblyaiModel: env.ASSEMBLYAI_MODEL || 'universal-3-5-pro',
  openaiModel: env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  backendUrl: env.BACKEND_URL || 'http://localhost:4000',
  clientUrl: env.CLIENT_URL || 'http://localhost:3000',
  buildEnvironment: buildEnv
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const files = [
  'manifest.json','background.js','script-processor.js','offscreen.html','offscreen.js','audio-processor.js',
  'popup.html','popup.css','popup.js','dashboard.html','dashboard.css','dashboard.js','transcribing.html','transcribing.css','transcribing.js',
  'meeting-detected.html','meeting-detected.css','meeting-detected.js','meeting-end-detector.js',
  'options.html','options.css','options.js','storage.js','onboarding.html','onboarding.css','onboarding.js',
  'request-mic.html','request-mic.js'
];
for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}
fs.cpSync(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true });

// Generate manifest permissions from the selected backend URL so QA builds
// work against the LAN server without manually editing dist/.
const manifestPath = path.join(dist, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const backendOrigin = new URL(config.backendUrl).origin;
manifest.host_permissions = Array.from(new Set([
  ...(manifest.host_permissions || []),
  `${backendOrigin}/*`
]));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

fs.writeFileSync(
  path.join(dist, 'runtime-config.js'),
  `// Generated from .env. This file is ignored by git.\n` +
  `globalThis.AI_NOTE_CONFIG = ${JSON.stringify(config, null, 2)};\n`
);

// The background service worker is intentionally a single classic script.
// Inject the same generated runtime config into it so it has no module imports.
const builtBackgroundPath = path.join(dist, 'background.js');
let builtBackground = fs.readFileSync(builtBackgroundPath, 'utf8');
builtBackground = builtBackground.replace(
  /globalThis\.AI_NOTE_CONFIG = \{[\s\S]*?\};\n+(?=\/\/ Offline script normalization)/,
  `globalThis.AI_NOTE_CONFIG = ${JSON.stringify(config, null, 2)};\n\n`
);
fs.writeFileSync(builtBackgroundPath, builtBackground);

console.log(`Build environment: ${buildEnv}`);
console.log(`Environment file: ${path.relative(root, envPath)}`);
console.log(`Backend URL: ${config.backendUrl}`);
console.log(`Built extension -> ${dist}`);
console.log(`Active provider: ${active}`);
console.log(`Configured providers: ${config.fallbackProviders.filter(p => config.keys[p]).join(', ') || 'none'}`);
