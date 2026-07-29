/**
 * offscreen.js
 * Runs inside the offscreen document (DOM context).
 * Owns the MediaStream, MediaRecorder (250 ms WebM/Opus chunks),
 * and the Deepgram Streaming WebSocket.
 *
 * Official protocol (https://developers.deepgram.com/reference/speech-to-text/listen-streaming):
 *   - Connect: wss://api.deepgram.com/v1/listen?<query>
 *   - Auth (browser): Sec-WebSocket-Protocol = "token", "<API_KEY>"
 *   - Send: binary audio frames
 *   - Control: JSON { "type": "CloseStream" } or { "type": "Finalize" }
 *   - Receive: JSON Results with is_final / speech_final
 */

console.log('[offscreen.js] Script loaded at', new Date().toISOString());

const DEEPGRAM_URL_BASE = 'wss://api.deepgram.com/v1/listen';
const TIMESLICE_MS = 250;
const MIME_TYPE = 'audio/webm;codecs=opus';

let mediaStream = null;
let mediaRecorder = null;
let deepgramSocket = null;
let isPaused = false;
let keepAliveInterval = null;

/**
 * Build the Deepgram listen URL.
 * languageMode: 'en' | 'ur' | 'multi'
 * Official multi code-switch: model=nova-3&language=multi (endpointing=100)
 * Urdu monolingual: model=nova-3&language=ur
 * English: model=nova-3&language=en
 */
function buildDeepgramUrl(languageMode = 'multi') {
  const mode = languageMode || 'multi';
  const model = 'nova-3';
  let language = 'en';
  let endpointing = '300';

  if (mode === 'ur') {
    language = 'ur';
  } else if (mode === 'multi') {
    language = 'multi';
    endpointing = '100';
  } else {
    language = 'en';
  }

  const params = new URLSearchParams({
    model,
    language,
    punctuate: 'true',
    interim_results: 'true',
    smart_format: 'true',
    endpointing
  });
  const url = `${DEEPGRAM_URL_BASE}?${params.toString()}`;
  console.log('[offscreen.js] Deepgram URL (mode=' + mode + '):', url);
  return url;
}

/**
 * Open WebSocket to Deepgram using the official browser auth method.
 * @param {string} apiKey
 * @param {string} [languageMode='multi']
 * @returns {Promise<WebSocket>}
 */
function connectDeepgram(apiKey, languageMode = 'multi') {
  return new Promise((resolve, reject) => {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 20) {
      console.error('[offscreen.js] Invalid or missing API key (length=', apiKey ? apiKey.length : 0, ')');
      reject(new Error('Invalid or missing Deepgram API key. Open Options and save a valid key.'));
      return;
    }

    console.log('[offscreen.js] Connecting to Deepgram WebSocket… key length=', apiKey.length, 'language=', languageMode);
    const url = buildDeepgramUrl(languageMode);

    // Official browser authentication: Sec-WebSocket-Protocol = "token", "<API_KEY>"
    // https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
    let socket;
    try {
      socket = new WebSocket(url, ['token', apiKey.trim()]);
    } catch (err) {
      console.error('[offscreen.js] WebSocket constructor threw:', err);
      reject(new Error('WebSocket constructor failed: ' + err.message));
      return;
    }

    socket.binaryType = 'arraybuffer';
    console.log('[offscreen.js] WebSocket created, readyState=', socket.readyState, '(0=CONNECTING)');

    let settled = false;

    const connectionTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error('[offscreen.js] WebSocket connection timeout after 15s, readyState=', socket.readyState);
      try { socket.close(); } catch (_) {}
      reject(new Error(
        'Deepgram WebSocket connection timed out. ' +
        'Check: 1) API key is valid 2) internet works 3) no firewall blocking api.deepgram.com 4) extension host permissions include api.deepgram.com'
      ));
    }, 15000);

    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      console.log('[offscreen.js] Deepgram WebSocket OPEN, readyState=', socket.readyState);
      resolve(socket);
    };

    socket.onerror = (event) => {
      console.error('[offscreen.js] Deepgram WebSocket ERROR event, readyState=', socket.readyState, event);
      // Don't reject here if close will follow — onclose often has the useful code.
      // Only reject if we haven't settled and readyState is already closed/closing.
      if (!settled && (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING)) {
        settled = true;
        clearTimeout(connectionTimeout);
        reject(new Error('Deepgram WebSocket connection failed (see console for details). Check API key and network.'));
      }
    };

    socket.onclose = (event) => {
      console.log(
        '[offscreen.js] Deepgram WebSocket CLOSED code=', event.code,
        'reason=', event.reason || '(none)',
        'wasClean=', event.wasClean,
        'readyState=', socket.readyState
      );
      stopKeepAlive();

      if (!settled) {
        settled = true;
        clearTimeout(connectionTimeout);
        // Common auth failure codes from servers
        let hint = '';
        if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
          hint = ' (likely invalid API key or unauthorized)';
        } else if (event.code === 1006) {
          hint = ' (abnormal closure – network, TLS, or blocked host)';
        }
        reject(new Error(
          `Deepgram WebSocket closed before open (code ${event.code})${hint}. ` +
          'Verify your API key in Options and that api.deepgram.com is reachable.'
        ));
      }
    };

    socket.onmessage = (event) => {
      handleDeepgramMessage(event.data);
    };
  });
}

/**
 * Parse incoming Deepgram messages and forward transcripts to background.
 * @param {string|ArrayBuffer} data
 */
function handleDeepgramMessage(data) {
  try {
    if (typeof data !== 'string') {
      console.warn('[offscreen.js] Received non-string message, ignoring');
      return;
    }

    const msg = JSON.parse(data);
    console.log('[offscreen.js] Deepgram message type=', msg.type, 'is_final=', msg.is_final, 'speech_final=', msg.speech_final);

    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      const transcript = alt?.transcript || '';
      if (!transcript) {
        // Empty interim – common, ignore
        return;
      }

      console.log('[offscreen.js] Transcript (is_final=' + msg.is_final + '):', transcript);

      chrome.runtime.sendMessage({
        target: 'background',
        type: 'TRANSCRIPT_UPDATE',
        transcript,
        is_final: Boolean(msg.is_final),
        speech_final: Boolean(msg.speech_final),
        confidence: alt?.confidence
      }).catch((err) => {
        console.error('[offscreen.js] Failed to send TRANSCRIPT_UPDATE:', err);
      });
    } else if (msg.type === 'Metadata') {
      console.log('[offscreen.js] Metadata received:', msg);
    } else if (msg.type === 'Error') {
      console.error('[offscreen.js] Deepgram Error message:', msg);
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'OFFSCREEN_ERROR',
        error: msg.message || JSON.stringify(msg)
      }).catch(() => {});
    } else {
      console.log('[offscreen.js] Unhandled Deepgram message type:', msg.type);
    }
  } catch (err) {
    console.error('[offscreen.js] Failed to parse Deepgram message:', err, data);
  }
}

/**
 * Start sending KeepAlive control messages when paused (no audio flowing).
 * Official message: { "type": "KeepAlive" }
 */
function startKeepAlive() {
  stopKeepAlive();
  console.log('[offscreen.js] Starting KeepAlive interval');
  keepAliveInterval = setInterval(() => {
    if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({ type: 'KeepAlive' });
      deepgramSocket.send(payload);
      console.log('[offscreen.js] Sent KeepAlive');
    }
  }, 8000); // well under the ~10 s silence timeout
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    console.log('[offscreen.js] KeepAlive stopped');
  }
}

/**
 * Acquire microphone and start MediaRecorder + Deepgram stream.
 * @param {string} apiKey
 */
async function startRecording(apiKey, languageMode = 'multi') {
  console.log('[offscreen.js] startRecording() begin, language=', languageMode);

  // Always clean any leftover state from a previous session in this document
  if (mediaRecorder || mediaStream || deepgramSocket) {
    console.log('[offscreen.js] Cleaning leftover state before start…');
    await cleanup();
  }

  try {
    // 1. Get user media
    console.log('[offscreen.js] Requesting getUserMedia...');
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
    console.log('[offscreen.js] getUserMedia success, tracks=', mediaStream.getTracks().map(t => t.kind + ':' + t.label));

    // 2. Connect Deepgram
    deepgramSocket = await connectDeepgram(apiKey, languageMode);

    // 3. Create MediaRecorder
    if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
      console.warn('[offscreen.js] Preferred MIME not supported, falling back to default');
    }

    const options = MediaRecorder.isTypeSupported(MIME_TYPE)
      ? { mimeType: MIME_TYPE }
      : {};

    mediaRecorder = new MediaRecorder(mediaStream, options);
    console.log('[offscreen.js] MediaRecorder created, mimeType=', mediaRecorder.mimeType);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN && !isPaused) {
          // Official: send raw binary audio chunks
          deepgramSocket.send(event.data);
          console.log('[offscreen.js] Sent audio chunk size=', event.data.size);
        } else {
          console.log('[offscreen.js] Skipping chunk (paused or socket not open), size=', event.data.size);
        }
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('[offscreen.js] MediaRecorder error:', event.error);
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'OFFSCREEN_ERROR',
        error: event.error?.message || 'MediaRecorder error'
      }).catch(() => {});
    };

    mediaRecorder.onstop = () => {
      console.log('[offscreen.js] MediaRecorder stopped');
    };

    // 4. Start with 250 ms timeslice (requirement)
    mediaRecorder.start(TIMESLICE_MS);
    isPaused = false;
    console.log('[offscreen.js] MediaRecorder started with timeslice=', TIMESLICE_MS);

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'OFFSCREEN_READY'
    }).catch(() => {});

  } catch (err) {
    console.error('[offscreen.js] startRecording() failed:', err);
    await cleanup();
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'OFFSCREEN_ERROR',
      error: err.message || String(err)
    }).catch(() => {});
    throw err;
  }
}

/**
 * Gracefully stop recording and close Deepgram stream.
 */
async function stopRecording() {
  console.log('[offscreen.js] stopRecording() begin');

  stopKeepAlive();

  // Stop MediaRecorder first so final dataavailable can fire
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
      console.log('[offscreen.js] MediaRecorder.stop() called');
    } catch (e) {
      console.warn('[offscreen.js] MediaRecorder.stop() error:', e);
    }
  }

  // Official CloseStream control message
  if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
    try {
      const closeMsg = JSON.stringify({ type: 'CloseStream' });
      deepgramSocket.send(closeMsg);
      console.log('[offscreen.js] Sent CloseStream');
      // Give a brief moment for final results
      await new Promise((r) => setTimeout(r, 300));
      deepgramSocket.close(1000, 'Client closed');
    } catch (e) {
      console.warn('[offscreen.js] Error closing Deepgram socket:', e);
    }
  }

  await cleanup();
  console.log('[offscreen.js] stopRecording() complete');
}

/**
 * Pause: stop sending audio but keep socket alive with KeepAlive.
 */
function pauseRecording() {
  console.log('[offscreen.js] pauseRecording()');
  isPaused = true;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    console.log('[offscreen.js] MediaRecorder paused');
  }
  startKeepAlive();
}

/**
 * Resume: continue sending audio.
 */
function resumeRecording() {
  console.log('[offscreen.js] resumeRecording()');
  isPaused = false;
  stopKeepAlive();
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    console.log('[offscreen.js] MediaRecorder resumed');
  }
}

/**
 * Release all media resources.
 */
async function cleanup() {
  console.log('[offscreen.js] cleanup()');
  stopKeepAlive();

  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    } catch (_) {}
    mediaRecorder = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => {
      track.stop();
      console.log('[offscreen.js] Track stopped:', track.kind, track.label);
    });
    mediaStream = null;
  }

  if (deepgramSocket) {
    try {
      if (deepgramSocket.readyState === WebSocket.OPEN || deepgramSocket.readyState === WebSocket.CONNECTING) {
        deepgramSocket.close();
      }
    } catch (_) {}
    deepgramSocket = null;
  }

  isPaused = false;
}

// ---------------------------------------------------------------------------
// Message listener from background
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== 'offscreen') {
    return false;
  }

  console.log('[offscreen.js] Message received:', message.type);

  (async () => {
    try {
      switch (message.type) {
        case 'OFFSCREEN_START':
          await startRecording(message.apiKey, message.language || 'multi');
          sendResponse({ ok: true });
          break;

        case 'OFFSCREEN_STOP':
          await stopRecording();
          sendResponse({ ok: true });
          break;

        case 'OFFSCREEN_PAUSE':
          pauseRecording();
          sendResponse({ ok: true });
          break;

        case 'OFFSCREEN_RESUME':
          resumeRecording();
          sendResponse({ ok: true });
          break;

        default:
          console.warn('[offscreen.js] Unknown message type:', message.type);
          sendResponse({ ok: false, error: 'Unknown type' });
      }
    } catch (err) {
      console.error('[offscreen.js] Handler error:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true; // async response
});

// Announce that the script is loaded and the message listener is registered.
// Background waits for this before sending OFFSCREEN_START.
chrome.runtime.sendMessage({
  target: 'background',
  type: 'OFFSCREEN_BOOTED'
}).then(() => {
  console.log('[offscreen.js] OFFSCREEN_BOOTED sent');
}).catch((err) => {
  console.warn('[offscreen.js] Could not send OFFSCREEN_BOOTED:', err.message || err);
});

console.log('[offscreen.js] Ready and listening for messages');
