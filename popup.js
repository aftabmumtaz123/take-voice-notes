/**
 * popup.js
 * Popup UI: writable textarea for live transcript, controls, word/char counts.
 * Communicates with background service worker via chrome.runtime messaging.
 * Listens to chrome.storage.onChanged for real-time updates.
 */

console.log('[popup.js] Script loaded at', new Date().toISOString());

// DOM references
const statusBadge = document.getElementById('statusBadge');
const apiKeyWarning = document.getElementById('apiKeyWarning');
const openOptionsLink = document.getElementById('openOptionsLink');
const optionsLink = document.getElementById('optionsLink');

const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnPause = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const btnNewNote = document.getElementById('btnNewNote');
const btnClear = document.getElementById('btnClear');
const btnCopy = document.getElementById('btnCopy');
const btnDownload = document.getElementById('btnDownload');

const transcriptArea = document.getElementById('transcriptArea');
const interimHint = document.getElementById('interimHint');
const wordCountEl = document.getElementById('wordCount');
const charCountEl = document.getElementById('charCount');
const timerEl = document.getElementById('timer');

let currentState = {
  isRecording: false,
  isPaused: false,
  startTime: null,
  totalPausedMs: 0
};
let timerInterval = null;
let userIsEditing = false;       // true while the textarea has focus
let suppressStorageWrite = false; // avoid feedback loop when we set value from storage
let saveDebounceTimer = null;

/**
 * Send a message to the background service worker and return the response.
 * @param {object} payload
 * @returns {Promise<object>}
 */
function sendToBackground(payload) {
  console.log('[popup.js] sendToBackground:', payload.type);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'background', ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[popup.js] Messaging error:', chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      console.log('[popup.js] Response:', response);
      resolve(response || { ok: false, error: 'No response' });
    });
  });
}

/**
 * Update the status badge and button enabled states.
 */
function updateUI() {
  console.log('[popup.js] updateUI() state=', JSON.stringify(currentState));

  const { isRecording, isPaused } = currentState;

  if (!isRecording) {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'badge badge-idle';
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnPause.disabled = true;
    btnResume.disabled = true;
  } else if (isPaused) {
    statusBadge.textContent = 'Paused';
    statusBadge.className = 'badge badge-paused';
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnPause.disabled = true;
    btnResume.disabled = false;
  } else {
    statusBadge.textContent = 'Recording';
    statusBadge.className = 'badge badge-recording';
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnPause.disabled = false;
    btnResume.disabled = true;
  }
}

/**
 * Update word and character counts from the textarea (+ interim hint).
 */
function updateCounts() {
  const final = transcriptArea.value || '';
  const interim = (interimHint.textContent || '').replace(/^…\s*/, '');
  const full = (final + (interim ? ' ' + interim : '')).trim();
  const words = full ? full.split(/\s+/).filter(Boolean).length : 0;
  const chars = full.length;

  wordCountEl.textContent = `Words: ${words}`;
  charCountEl.textContent = `Characters: ${chars}`;
}

/**
 * Format milliseconds as MM:SS.
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Start or stop the elapsed-time timer.
 */
function manageTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (currentState.isRecording && !currentState.isPaused && currentState.startTime) {
    timerInterval = setInterval(() => {
      const elapsed = Date.now() - currentState.startTime - (currentState.totalPausedMs || 0);
      timerEl.textContent = formatTime(Math.max(0, elapsed));
    }, 500);
  } else if (!currentState.isRecording) {
    timerEl.textContent = '00:00';
  }
}

/**
 * Set textarea value without scrolling the user away if they're at the bottom,
 * and without treating it as a user edit.
 * @param {string} text
 */
function setTranscriptValue(text) {
  suppressStorageWrite = true;
  const wasAtBottom =
    transcriptArea.scrollHeight - transcriptArea.scrollTop - transcriptArea.clientHeight < 40;

  transcriptArea.value = text || '';

  if (wasAtBottom) {
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
  }
  suppressStorageWrite = false;
  updateCounts();
}

/**
 * Show or hide the interim (partial) transcript hint below the textarea.
 * @param {string} text
 */
function setInterimHint(text) {
  const t = (text || '').trim();
  if (t) {
    interimHint.textContent = '… ' + t;
    interimHint.classList.remove('hidden');
  } else {
    interimHint.textContent = '';
    interimHint.classList.add('hidden');
  }
  updateCounts();
}

/**
 * Persist the current textarea content to storage (debounced).
 */
function scheduleSaveTranscript() {
  if (suppressStorageWrite) return;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(async () => {
    const text = transcriptArea.value;
    console.log('[popup.js] Saving edited transcript, length=', text.length);
    try {
      await chrome.storage.local.set({
        currentTranscript: text,
        lastUpdated: Date.now()
      });
    } catch (err) {
      console.error('[popup.js] Failed to save transcript:', err);
    }
  }, 400);
}

/**
 * Apply a storage snapshot to the UI.
 * Does not overwrite the textarea if the user is actively editing.
 * @param {object} snapshot
 */
function applySnapshot(snapshot) {
  console.log('[popup.js] applySnapshot() userIsEditing=', userIsEditing);
  if (!userIsEditing) {
    setTranscriptValue(snapshot.transcript || '');
  }
  setInterimHint(snapshot.interim || '');
  currentState = snapshot.recordingState || currentState;
  updateUI();
  manageTimer();

  if (snapshot.hasApiKey === false) {
    apiKeyWarning.classList.remove('hidden');
  } else {
    apiKeyWarning.classList.add('hidden');
  }
}

/**
 * Load initial state from background.
 */
async function loadInitialState() {
  console.log('[popup.js] loadInitialState()');
  const res = await sendToBackground({ type: 'GET_STATE' });
  if (res.ok) {
    applySnapshot(res);
  } else {
    console.error('[popup.js] Failed to load state:', res.error);
  }
}

// ---------------------------------------------------------------------------
// Textarea: editable + auto-save
// ---------------------------------------------------------------------------
transcriptArea.addEventListener('focus', () => {
  userIsEditing = true;
  console.log('[popup.js] Textarea focused – user editing');
});

transcriptArea.addEventListener('blur', () => {
  userIsEditing = false;
  console.log('[popup.js] Textarea blurred');
  scheduleSaveTranscript();
});

transcriptArea.addEventListener('input', () => {
  updateCounts();
  scheduleSaveTranscript();
});

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------
btnStart.addEventListener('click', async () => {
  console.log('[popup.js] Start clicked');
  btnStart.disabled = true;

  // Offscreen documents cannot show the mic permission prompt.
  // Request getUserMedia here first (visible popup + user gesture).
  try {
    console.log('[popup.js] Pre-requesting microphone permission from popup…');
    const tempStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
    tempStream.getTracks().forEach((t) => t.stop());
    console.log('[popup.js] Microphone permission granted (temp stream stopped)');
  } catch (err) {
    console.error('[popup.js] Microphone permission failed:', err.name, err.message);
    btnStart.disabled = false;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      alert(
        'Microphone permission was denied or dismissed.\n\n' +
        'Please allow microphone access when Chrome asks, then try Start again.\n\n' +
        'You can also check chrome://settings/content/microphone and make sure this extension is allowed.'
      );
    } else if (err.name === 'NotFoundError') {
      alert('No microphone found. Please connect a microphone and try again.');
    } else {
      alert('Could not access microphone: ' + (err.message || err.name));
    }
    return;
  }

  const res = await sendToBackground({ type: 'START_RECORDING' });
  if (!res.ok) {
    alert(res.error || 'Failed to start recording');
    btnStart.disabled = false;
    return;
  }
  currentState = res.state || { isRecording: true, isPaused: false, startTime: Date.now(), totalPausedMs: 0 };
  updateUI();
  manageTimer();
});

btnStop.addEventListener('click', async () => {
  console.log('[popup.js] Stop clicked');
  // Flush any pending edits before stop
  scheduleSaveTranscript();
  const res = await sendToBackground({ type: 'STOP_RECORDING' });
  if (res.ok) {
    currentState = { isRecording: false, isPaused: false, startTime: null, totalPausedMs: 0 };
    setInterimHint('');
    updateUI();
    manageTimer();
    updateCounts();
  }
});

btnPause.addEventListener('click', async () => {
  console.log('[popup.js] Pause clicked');
  const res = await sendToBackground({ type: 'PAUSE_RECORDING' });
  if (res.ok) {
    currentState.isPaused = true;
    currentState.pauseTime = Date.now();
    updateUI();
    manageTimer();
  }
});

btnResume.addEventListener('click', async () => {
  console.log('[popup.js] Resume clicked');
  const res = await sendToBackground({ type: 'RESUME_RECORDING' });
  if (res.ok) {
    currentState.isPaused = false;
    currentState.pauseTime = null;
    updateUI();
    manageTimer();
  }
});

btnNewNote.addEventListener('click', async () => {
  console.log('[popup.js] New Note clicked');
  if (!confirm('Start a new note? Current transcript will be cleared.')) return;
  const res = await sendToBackground({ type: 'NEW_NOTE' });
  if (res.ok) {
    setTranscriptValue('');
    setInterimHint('');
    currentState = { isRecording: false, isPaused: false, startTime: null, totalPausedMs: 0 };
    updateUI();
    manageTimer();
    updateCounts();
  }
});

btnClear.addEventListener('click', async () => {
  console.log('[popup.js] Clear clicked');
  if (!confirm('Clear the current transcript?')) return;
  const res = await sendToBackground({ type: 'CLEAR_NOTE' });
  if (res.ok) {
    setTranscriptValue('');
    setInterimHint('');
    updateCounts();
  }
});

btnCopy.addEventListener('click', async () => {
  console.log('[popup.js] Copy clicked');
  const text = transcriptArea.value.trim();
  if (!text) {
    alert('Nothing to copy');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    const original = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = original; }, 1500);
  } catch (err) {
    console.error('[popup.js] Clipboard error:', err);
    alert('Failed to copy');
  }
});

btnDownload.addEventListener('click', () => {
  console.log('[popup.js] Download clicked');
  const text = transcriptArea.value.trim();
  if (!text) {
    alert('Nothing to download');
    return;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `voice-note-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// Options links
function openOptions(e) {
  e.preventDefault();
  console.log('[popup.js] Opening options page');
  chrome.runtime.openOptionsPage();
}
openOptionsLink.addEventListener('click', openOptions);
optionsLink.addEventListener('click', openOptions);

// ---------------------------------------------------------------------------
// Live updates via storage
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  console.log('[popup.js] storage.onChanged keys=', Object.keys(changes));

  if (changes.currentTranscript && !userIsEditing) {
    setTranscriptValue(changes.currentTranscript.newValue || '');
  }
  if (changes.interimTranscript) {
    setInterimHint(changes.interimTranscript.newValue || '');
  }
  if (changes.recordingState) {
    currentState = changes.recordingState.newValue || currentState;
    updateUI();
    manageTimer();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  console.log('[popup.js] DOMContentLoaded');
  loadInitialState();
});

console.log('[popup.js] Event listeners attached');
