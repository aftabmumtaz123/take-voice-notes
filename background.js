/**
 * background.js
 * Manifest V3 service worker.
 * Manages recording state, creates/closes the offscreen document,
 * relays messages between popup and offscreen, and persists state via storage.
 */

import {
  getApiKey,
  getLanguage,
  getRecordingState,
  setRecordingState,
  getTranscript,
  setTranscript,
  setInterim,
  clearNote,
  getNoteSnapshot
} from './storage.js';

console.log('[background.js] Service worker starting at', new Date().toISOString());

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASON = 'USER_MEDIA';
const OFFSCREEN_JUSTIFICATION = 'Continuous microphone capture and MediaRecorder for real-time Deepgram streaming transcription.';

let offscreenCreating = null; // Promise guard to avoid concurrent createDocument calls
let offscreenBootResolver = null; // resolves when offscreen sends OFFSCREEN_BOOTED

/**
 * True if an offscreen document is currently open.
 */
async function hasOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return existing.length > 0;
}

/**
 * Close the offscreen document if it exists.
 * @returns {Promise<void>}
 */
async function closeOffscreenDocument() {
  console.log('[background.js] closeOffscreenDocument() called');
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
      console.log('[background.js] Offscreen document closed');
      // Brief pause so Chrome fully tears down the context
      await new Promise((r) => setTimeout(r, 150));
    } else {
      console.log('[background.js] No offscreen document to close');
    }
  } catch (err) {
    console.error('[background.js] Error closing offscreen document:', err);
  }
}

/**
 * Create a fresh offscreen document and wait until its script has loaded
 * and registered the message listener (OFFSCREEN_BOOTED).
 * Always closes any existing document first so every recording starts clean.
 * @returns {Promise<void>}
 */
async function ensureFreshOffscreenDocument() {
  console.log('[background.js] ensureFreshOffscreenDocument() called');

  // Always start from a clean slate – prevents stale MediaRecorder / WebSocket
  await closeOffscreenDocument();

  if (offscreenCreating) {
    console.log('[background.js] Offscreen creation already in progress, awaiting...');
    await offscreenCreating;
    return;
  }

  // Promise that resolves when offscreen.js posts OFFSCREEN_BOOTED
  const bootPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offscreenBootResolver = null;
      reject(new Error('Offscreen document did not boot in time'));
    }, 8000);
    offscreenBootResolver = () => {
      clearTimeout(timer);
      offscreenBootResolver = null;
      resolve();
    };
  });

  console.log('[background.js] Creating offscreen document...');
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification: OFFSCREEN_JUSTIFICATION
  });

  try {
    await offscreenCreating;
    console.log('[background.js] Offscreen document created – waiting for boot…');
    await bootPromise;
    console.log('[background.js] Offscreen document booted and ready');
  } catch (err) {
    console.error('[background.js] Failed to create/boot offscreen document:', err);
    offscreenBootResolver = null;
    throw err;
  } finally {
    offscreenCreating = null;
  }
}

/**
 * Send a message to the offscreen document (with one retry).
 * @param {object} message
 * @returns {Promise<any>}
 */
async function sendToOffscreen(message) {
  console.log('[background.js] sendToOffscreen():', message.type || message);
  const payload = { target: 'offscreen', ...message };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(payload);
      console.log('[background.js] sendToOffscreen() response (attempt', attempt, '):', response);
      return response;
    } catch (err) {
      console.error('[background.js] sendToOffscreen() error attempt', attempt, ':', err.message || err);
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Broadcast state update to any open popup listeners via storage change
 * (popup listens to chrome.storage.onChanged).
 * Also used after local state mutations.
 */
async function notifyStateChange() {
  console.log('[background.js] notifyStateChange() – storage already updated, listeners will fire');
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[background.js] onMessage received:', message.type || message, 'from', sender.url || sender.id);

  // Only process messages intended for background (or without target)
  if (message.target && message.target !== 'background') {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'GET_STATE': {
          const snapshot = await getNoteSnapshot();
          const apiKey = await getApiKey();
          sendResponse({
            ok: true,
            ...snapshot,
            hasApiKey: Boolean(apiKey)
          });
          break;
        }

        case 'START_RECORDING': {
          console.log('[background.js] START_RECORDING');
          const apiKey = await getApiKey();
          if (!apiKey) {
            sendResponse({ ok: false, error: 'No Deepgram API key configured. Open Options to set it.' });
            return;
          }

          // Fresh offscreen every session so second+ recordings always work
          await ensureFreshOffscreenDocument();

          // Clear only interim; keep previous final transcript unless user hits New/Clear
          await setInterim('');

          const state = await setRecordingState({
            isRecording: true,
            isPaused: false,
            startTime: Date.now(),
            pauseTime: null,
            totalPausedMs: 0
          });

          const language = await getLanguage();
          console.log('[background.js] Using language mode:', language);

          const startRes = await sendToOffscreen({
            type: 'OFFSCREEN_START',
            apiKey,
            language
          });

          if (startRes && startRes.ok === false) {
            await setRecordingState({ isRecording: false, isPaused: false });
            await closeOffscreenDocument();
            sendResponse({ ok: false, error: startRes.error || 'Offscreen failed to start' });
            return;
          }

          await notifyStateChange();
          sendResponse({ ok: true, state });
          break;
        }

        case 'STOP_RECORDING': {
          console.log('[background.js] STOP_RECORDING');
          try {
            await sendToOffscreen({ type: 'OFFSCREEN_STOP' });
          } catch (e) {
            console.warn('[background.js] Offscreen may already be gone:', e.message);
          }

          await setRecordingState({
            isRecording: false,
            isPaused: false,
            startTime: null,
            pauseTime: null,
            totalPausedMs: 0
          });
          await setInterim('');
          // Fully tear down so the next Start creates a clean document
          await closeOffscreenDocument();
          await notifyStateChange();
          sendResponse({ ok: true });
          break;
        }

        case 'PAUSE_RECORDING': {
          console.log('[background.js] PAUSE_RECORDING');
          await sendToOffscreen({ type: 'OFFSCREEN_PAUSE' });
          await setRecordingState({
            isPaused: true,
            pauseTime: Date.now()
          });
          await notifyStateChange();
          sendResponse({ ok: true });
          break;
        }

        case 'RESUME_RECORDING': {
          console.log('[background.js] RESUME_RECORDING');
          const current = await getRecordingState();
          let totalPausedMs = current.totalPausedMs || 0;
          if (current.pauseTime) {
            totalPausedMs += Date.now() - current.pauseTime;
          }
          await sendToOffscreen({ type: 'OFFSCREEN_RESUME' });
          await setRecordingState({
            isPaused: false,
            pauseTime: null,
            totalPausedMs
          });
          await notifyStateChange();
          sendResponse({ ok: true });
          break;
        }

        case 'NEW_NOTE': {
          console.log('[background.js] NEW_NOTE');
          // Stop if recording, then clear
          const state = await getRecordingState();
          if (state.isRecording) {
            try {
              await sendToOffscreen({ type: 'OFFSCREEN_STOP' });
            } catch (_) {}
            await closeOffscreenDocument();
          }
          await clearNote();
          await notifyStateChange();
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_NOTE': {
          console.log('[background.js] CLEAR_NOTE');
          await setTranscript('');
          await setInterim('');
          await notifyStateChange();
          sendResponse({ ok: true });
          break;
        }

        // Messages coming FROM the offscreen document
        case 'TRANSCRIPT_UPDATE': {
          console.log('[background.js] TRANSCRIPT_UPDATE is_final=', message.is_final, 'text length=', (message.transcript || '').length);
          if (message.is_final) {
            const existing = await getTranscript();
            const addition = (message.transcript || '').trim();
            if (addition) {
              const separator = existing && !existing.endsWith(' ') && !existing.endsWith('\n') ? ' ' : '';
              const next = existing + separator + addition;
              await setTranscript(next);
            }
            await setInterim('');
          } else {
            await setInterim(message.transcript || '');
          }
          // Popup listens via storage.onChanged – no extra broadcast needed
          sendResponse({ ok: true });
          break;
        }

        case 'OFFSCREEN_ERROR': {
          console.error('[background.js] OFFSCREEN_ERROR:', message.error);
          await setRecordingState({ isRecording: false, isPaused: false });
          await setInterim('');
          await notifyStateChange();
          sendResponse({ ok: true });
          break;
        }

        case 'OFFSCREEN_BOOTED': {
          console.log('[background.js] Offscreen script booted');
          if (offscreenBootResolver) {
            offscreenBootResolver();
          }
          sendResponse({ ok: true });
          break;
        }

        case 'OFFSCREEN_READY': {
          console.log('[background.js] Offscreen reported recording ready');
          sendResponse({ ok: true });
          break;
        }

        default:
          console.warn('[background.js] Unknown message type:', message.type);
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[background.js] Message handler error:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  // Keep the message channel open for async response
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[background.js] onInstalled reason=', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[background.js] onStartup – service worker woken');
});

// Keep service worker alive while recording by periodically touching storage
// (optional; Chrome may still suspend, but offscreen keeps media alive)
setInterval(async () => {
  const state = await getRecordingState();
  if (state.isRecording) {
    console.log('[background.js] Keep-alive tick while recording');
  }
}, 20000);

console.log('[background.js] Service worker initialized and listening for messages');
