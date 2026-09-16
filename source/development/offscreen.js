import './runtime-config.js';

const CONFIG = globalThis.AI_NOTE_CONFIG || {};
const DG_URL = 'wss://api.deepgram.com/v1/listen';
const AAI_WS = 'wss://streaming.assemblyai.com/v3/ws';
const OPENAI_TRANSCRIBE = 'https://api.openai.com/v1/audio/transcriptions';
const MEDIA_MIME = 'audio/webm;codecs=opus';

let mediaStream = null;
let tabAudioStream = null;
let micAudioStream = null;
let tabAudioSource = null;
let micAudioSource = null;
let mixerNode = null;
let tabPlaybackGain = null;
let mediaRecorder = null;
let audioContext = null;
let audioSource = null;
let audioWorklet = null;
let socket = null;
let provider = null;
let paused = false;
let keepAlive = null;
let openAiChunks = [];
let openAiTimer = null;
let openAiBusy = false;
let openAiSequence = 0;
let assemblyPcmBuffer = new Int16Array(0);
const ASSEMBLY_FRAME_SAMPLES = 1600; // 100 ms at 16 kHz; AssemblyAI accepts 50–1000 ms frames

const send = (message) => chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});

function providerKey(name) {
  return CONFIG.keys?.[name] || '';
}

function configuredProviders() {
  const order = Array.isArray(CONFIG.fallbackProviders) ? CONFIG.fallbackProviders : [CONFIG.activeProvider];
  return [...new Set(order)].filter(name => providerKey(name));
}

function postTranscript(text, isFinal, extra = {}) {
  if (!text?.trim()) return;
  send({
    type: 'TRANSCRIPT_UPDATE',
    transcript: text.trim(),
    is_final: Boolean(isFinal),
    speech_final: Boolean(extra.speechFinal),
    provider,
    confidence: extra.confidence
  });
}

function buildDeepgramUrl() {
  const params = new URLSearchParams({
    model: CONFIG.deepgramModel || 'nova-3',
    language: 'multi',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300'
  });
  return `${DG_URL}?${params}`;
}

function connectDeepgram() {
  return new Promise((resolve, reject) => {
    const key = providerKey('deepgram');
    const ws = new WebSocket(buildDeepgramUrl(), ['token', key]);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('Deepgram connection timed out'));
    }, 12000);

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket = ws;
      resolve(ws);
    };
    ws.onerror = () => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error('Deepgram connection failed'));
      } else {
        send({ type: 'OFFSCREEN_ERROR', error: 'Deepgram connection failed' });
      }
    };
    ws.onclose = (e) => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error(`Deepgram closed before connection (${e.code})`));
      }
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0];
          postTranscript(alt?.transcript, Boolean(msg.is_final), {
            speechFinal: msg.speech_final, confidence: alt?.confidence
          });
        } else if (msg.type === 'Error') {
          send({ type: 'OFFSCREEN_ERROR', error: msg.message || 'Deepgram error' });
        }
      } catch {}
    };
  });
}

async function getAssemblyToken() {
  const response = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=600', {
    headers: { Authorization: providerKey('assemblyai') }
  });
  if (!response.ok) throw new Error(`AssemblyAI token request failed (${response.status})`);
  const data = await response.json();
  if (!data.token) throw new Error('AssemblyAI did not return a streaming token');
  return data.token;
}

async function connectAssemblyAI() {
  const token = await getAssemblyToken();
  // Universal-3.5 Pro Realtime is promptable. Give the model meeting/dev
  // context so English product names and technical vocabulary are not
  // phoneticized when the speaker code-switches between English and Hindi/Urdu.
  const transcriptPrompt =
    'Transcribe a software development team meeting with natural English, ' +
    'Hindi, Urdu, and Hinglish code-switching. Preserve English technical terms, ' +
    'company names, product names, browser names, programming terms, URLs, and ' +
    'common developer vocabulary exactly as spoken. Do not translate English ' +
    'words into Hindi or Urdu. Prefer the correct English spelling for known ' +
    'technical/product terms and use surrounding context to resolve phonetic ' +
    'Hindi or Urdu speech.';

  const transcriptKeyterms = [
    'Microsoft', 'Bing', 'Google', 'Chrome', 'Edge', 'Firefox',
    'homepage', 'default search engine', 'search engine', 'default browser',
    'Zoom', 'Google Meet', 'Microsoft Teams', 'AssemblyAI', 'Deepgram',
    'OpenAI', 'ChatGPT', 'API', 'APIs', 'WebSocket', 'WebSockets',
    'JavaScript', 'TypeScript', 'React', 'Next.js', 'Node.js', 'Express',
    'MongoDB', 'MySQL', 'PostgreSQL', 'SQL', 'GitHub', 'GitLab',
    'frontend', 'backend', 'full stack', 'deployment', 'production',
    'development', 'developer', 'meeting', 'transcription', 'transcript',
    'authentication', 'authorization', 'database', 'server', 'client',
    'browser', 'extension', 'Chrome extension', 'API key', 'endpoint',
    'refresh', 'page', 'tab', 'link', 'login', 'logout'
  ];

  const params = new URLSearchParams({
    sample_rate: '16000',
    speech_model: CONFIG.assemblyaiModel || 'universal-3-5-pro',
    encoding: 'pcm_s16le',
    mode: 'balanced',
    prompt: transcriptPrompt,
    keyterms_prompt: JSON.stringify(transcriptKeyterms),
    token
  });

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${AAI_WS}?${params}`);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('AssemblyAI connection timed out'));
    }, 12000);

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket = ws;
      resolve(ws);
    };
    ws.onerror = () => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error('AssemblyAI connection failed'));
      } else {
        send({ type: 'OFFSCREEN_ERROR', error: 'AssemblyAI connection failed' });
      }
    };
    ws.onclose = (e) => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error(`AssemblyAI closed before connection (${e.code})`));
      } else if (provider === 'assemblyai' && !paused) {
        send({ type: 'OFFSCREEN_ERROR', error: `AssemblyAI stream closed (${e.code}${e.reason ? `: ${e.reason}` : ''})` });
      }
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Turn') {
          postTranscript(msg.transcript, Boolean(msg.end_of_turn), {
            speechFinal: Boolean(msg.end_of_turn),
            confidence: msg.end_of_turn_confidence
          });
        } else if (msg.type === 'Error') {
          send({ type: 'OFFSCREEN_ERROR', error: msg.error || msg.message || 'AssemblyAI error' });
        }
      } catch {}
    };
  });
}

function startKeepAlive() {
  stopKeepAlive();
  keepAlive = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (provider === 'deepgram') socket.send(JSON.stringify({ type: 'KeepAlive' }));
    // AssemblyAI sessions are kept alive by the service; no control message is needed.
  }, 8000);
}

function stopKeepAlive() {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function resample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    output[i] = input[left] + (input[right] - input[left]) * frac;
  }
  return output;
}


function setupDeepgramCapture() {
  // Deepgram uses the same mixed PCM pipeline as AssemblyAI so remote meeting
  // audio and microphone audio are both transcribed.
  return setupPcmCapture();
}

async function setupPcmCapture({ tabCaptureStreamId = null } = {}) {
  audioContext = new AudioContext();

  // Microphone is always captured. When a meeting tab stream ID is supplied,
  // capture the meeting tab's audio as well and mix both sources before the
  // PCM worklet. The tab audio is also routed back to the speakers because
  // Chrome mutes tab playback while tabCapture is active.
  micAudioStream = mediaStream;
  micAudioSource = audioContext.createMediaStreamSource(micAudioStream);

  if (tabCaptureStreamId) {
    try {
      tabAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: tabCaptureStreamId
          }
        },
        video: false
      });
    } catch (err) {
      throw new Error(`Unable to capture meeting audio: ${err.message || err}`);
    }
    tabAudioSource = audioContext.createMediaStreamSource(tabAudioStream);
  }

  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));
  audioWorklet = new AudioWorkletNode(audioContext, 'pcm-processor');

  mixerNode = audioContext.createGain();
  mixerNode.gain.value = 1;
  micAudioSource.connect(mixerNode);

  if (tabAudioSource) {
    const remoteMixGain = audioContext.createGain();
    remoteMixGain.gain.value = 1;
    tabAudioSource.connect(remoteMixGain);
    remoteMixGain.connect(mixerNode);

    // Preserve normal meeting playback for the user while the tab is captured.
    tabPlaybackGain = audioContext.createGain();
    tabPlaybackGain.gain.value = 1;
    tabAudioSource.connect(tabPlaybackGain);
    tabPlaybackGain.connect(audioContext.destination);
  }

  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  mixerNode.connect(audioWorklet);
  audioWorklet.connect(silentGain);
  silentGain.connect(audioContext.destination);

  audioWorklet.port.onmessage = ({ data }) => {
    if (paused) return;

    if ((provider === 'assemblyai' || provider === 'deepgram') && socket?.readyState === WebSocket.OPEN) {
      // AudioWorklet usually delivers ~128 samples per callback. Buffer the
      // mixed microphone + meeting audio into 100 ms PCM16 frames before sending.
      const floatChunk = resample(data, audioContext.sampleRate, 16000);
      const pcmChunk = floatToPcm16(floatChunk);
      const merged = new Int16Array(assemblyPcmBuffer.length + pcmChunk.length);
      merged.set(assemblyPcmBuffer, 0);
      merged.set(pcmChunk, assemblyPcmBuffer.length);
      assemblyPcmBuffer = merged;

      while (assemblyPcmBuffer.length >= ASSEMBLY_FRAME_SAMPLES && socket?.readyState === WebSocket.OPEN) {
        const frame = assemblyPcmBuffer.slice(0, ASSEMBLY_FRAME_SAMPLES);
        assemblyPcmBuffer = assemblyPcmBuffer.slice(ASSEMBLY_FRAME_SAMPLES);
        socket.send(frame.buffer);
      }
    } else if (provider === 'openai') {
      openAiChunks.push(data);
    }
  };
}

function pcmToWav(chunks, sampleRate) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    const pcm = floatToPcm16(chunk);
    for (let i = 0; i < pcm.length; i++, offset += 2) view.setInt16(offset, pcm[i], true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function flushOpenAIChunk() {
  if (openAiBusy || !openAiChunks.length || paused) return;
  openAiBusy = true;
  const chunks = openAiChunks.splice(0);
  const sequence = ++openAiSequence;
  try {
    const wav = pcmToWav(chunks, audioContext.sampleRate);
    const form = new FormData();
    form.append('file', wav, `segment-${sequence}.wav`);
    form.append('model', CONFIG.openaiModel || 'gpt-4o-mini-transcribe');
    const response = await fetch(OPENAI_TRANSCRIBE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${providerKey('openai')}` },
      body: form
    });
    if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status})`);
    const data = await response.json();
    postTranscript(data.text, true);
  } catch (err) {
    send({ type: 'OFFSCREEN_ERROR', error: err.message || 'OpenAI transcription failed' });
  } finally {
    openAiBusy = false;
  }
}

async function startProvider(name) {
  provider = name;
  if (name === 'deepgram') await connectDeepgram();
  else if (name === 'assemblyai') await connectAssemblyAI();
  else if (name === 'openai') {
    // OpenAI's audio transcription endpoint is file/segment based. It is intentionally
    // treated as a near-live fallback while Deepgram/AssemblyAI provide true streaming.
  } else throw new Error(`Unsupported provider: ${name}`);
}

async function startRecording(options = {}) {
  await cleanup();
  const providers = configuredProviders();
  if (!providers.length) throw new Error('No transcription provider is configured. Set provider keys in the developer .env file.');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false
  });

  let lastError = null;
  for (const candidate of providers) {
    try {
      await startProvider(candidate);
      await setupPcmCapture({ tabCaptureStreamId: options.tabCaptureStreamId || null });
      if (candidate === 'openai') {
        openAiTimer = setInterval(flushOpenAIChunk, 4000);
      }
      startKeepAlive();
      send({ type: 'OFFSCREEN_READY', provider: candidate });
      return;
    } catch (err) {
      lastError = err;
      await cleanupSocketsOnly();
    }
  }
  await cleanup();
  throw lastError || new Error('No configured transcription provider could connect');
}

async function cleanupSocketsOnly() {
  stopKeepAlive();
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        if (provider === 'deepgram') socket.send(JSON.stringify({ type: 'CloseStream' }));
        if (provider === 'assemblyai') socket.send(JSON.stringify({ type: 'Terminate' }));
      }
      socket.close();
    } catch {}
  }
  socket = null;
}

async function stopRecording() {
  stopKeepAlive();
  if (provider === 'openai') await flushOpenAIChunk();
  await cleanup();
}

function pauseRecording() {
  paused = true;
  if (audioContext && audioContext.state === 'running') audioContext.suspend().catch(() => {});
  startKeepAlive();
}

function resumeRecording() {
  paused = false;
  if (audioContext && audioContext.state === 'suspended') audioContext.resume().catch(() => {});
}

async function cleanup() {
  stopKeepAlive();
  if (openAiTimer) clearInterval(openAiTimer);
  openAiTimer = null;
  openAiChunks = [];
  openAiBusy = false;
  assemblyPcmBuffer = new Int16Array(0);

  await cleanupSocketsOnly();

  if (mediaRecorder) {
    try { if (mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;

  if (audioWorklet) {
    try { audioWorklet.disconnect(); } catch {}
  }
  audioWorklet = null;
  if (audioSource) {
    try { audioSource.disconnect(); } catch {}
  }
  audioSource = null;
  if (audioContext) {
    try { await audioContext.close(); } catch {}
  }
  audioContext = null;

  if (tabAudioStream) tabAudioStream.getTracks().forEach(track => track.stop());
  tabAudioStream = null;
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
  mediaStream = null;
  micAudioStream = null;
  tabAudioSource = null;
  micAudioSource = null;
  mixerNode = null;
  tabPlaybackGain = null;
  provider = null;
  paused = false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== 'offscreen') return false;
  (async () => {
    try {
      if (message.type === 'OFFSCREEN_START') {
        await startRecording(message.data || {});
        sendResponse({ ok: true, provider });
      } else if (message.type === 'OFFSCREEN_STOP') {
        await stopRecording();
        sendResponse({ ok: true });
      } else if (message.type === 'OFFSCREEN_PAUSE') {
        pauseRecording(); sendResponse({ ok: true });
      } else if (message.type === 'OFFSCREEN_RESUME') {
        resumeRecording(); sendResponse({ ok: true });
      } else sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});

send({ type: 'OFFSCREEN_BOOTED' });
