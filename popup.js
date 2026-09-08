const $ = (id) => document.getElementById(id);

const statusBadge = $('statusBadge');
const statusDot = $('statusDot');
const providerLabel = $('providerLabel');
const transcriptArea = $('transcriptArea');
const sessionTitle = $('sessionTitle');
const interimHint = $('interimHint');
const emptyState = $('emptyState');
const timerEl = $('timer');
const wordCountEl = $('wordCount');
const charCountEl = $('charCount');
const scriptModeEl = $('scriptMode');
const btnStart = $('btnStart');
const btnStop = $('btnStop');
const btnPause = $('btnPause');
const btnResume = $('btnResume');
const btnNewNote = $('btnNewNote');
const btnClear = $('btnClear');
const btnCopy = $('btnCopy');
const btnDownload = $('btnDownload');
const btnSaveAnalyze = $('btnSaveAnalyze');
const optionsLink = $('optionsLink');
const dashboardLink = $('dashboardLink');
const authGate = $('authGate');
const mainApp = $('mainApp');
const authServerUrl = $('authServerUrl');
const authApiKey = $('authApiKey');
const btnSaveApiKey = $('btnSaveApiKey');
const btnOpenWebAuth = $('btnOpenWebAuth');
const authGateError = $('authGateError');
const authFooter = $('authFooter');
const logoutLink = $('logoutLink');
const meetingDetected = $('meetingDetected');
const meetingDetectedIcon = $('meetingDetectedIcon');
const meetingDetectedTitle = $('meetingDetectedTitle');
const meetingDetectedMeta = $('meetingDetectedMeta');
const meetingDismiss = $('meetingDismiss');

let currentState = { isRecording:false, isPaused:false, startTime:null, totalPausedMs:0 };
let pendingMeeting = null;
let userIsEditing = false;
let saveTimer = null;
let timerInterval = null;

const send = (type, data = {}) => new Promise((resolve) => {
  chrome.runtime.sendMessage({ target:'background', type, ...data }, resolve);
});


const toastHost = $('toastHost');
const modalHost = $('modalHost');

const TOAST_ICONS = { error: '!', success: '✓', info: 'i', warn: '!' };

function showToast(message, { title = '', type = 'info', duration = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-icon">${TOAST_ICONS[type] || 'i'}</div>
    <div class="toast-body">
      ${title ? `<div class="toast-title">${title}</div>` : ''}
      <div class="toast-msg">${message}</div>
    </div>
    <button class="toast-close" type="button" aria-label="Dismiss">×</button>
  `;
  const remove = () => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 180);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  toastHost.appendChild(el);
  if (duration > 0) setTimeout(remove, duration);
  return el;
}

function showConfirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title || 'Confirm'}</div>
        <div class="modal-msg">${message || ''}</div>
        <div class="modal-actions">
          <button class="modal-btn cancel" type="button">${cancelLabel}</button>
          <button class="modal-btn ${danger ? 'danger' : 'primary'}" type="button">${confirmLabel}</button>
        </div>
      </div>
    `;
    const close = (result) => {
      overlay.classList.add('hiding');
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 150);
    };
    overlay.querySelector('.cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-btn.' + (danger ? 'danger' : 'primary')).addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    modalHost.appendChild(overlay);
  });
}


function formatTime(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}

function updateCounts() {
  const full = `${transcriptArea.value || ''} ${interimHint.textContent.replace(/^…\s*/,'')}`.trim();
  wordCountEl.textContent = `${full ? full.split(/\s+/).length : 0} words`;
  charCountEl.textContent = `${full.length} chars`;
  emptyState.classList.toggle('hidden', Boolean(full));
}

function updateUI() {
  const {isRecording,isPaused} = currentState;
  statusBadge.textContent = isRecording ? (isPaused ? 'Paused' : 'Recording') : 'Ready';
  statusDot.className = `status-dot ${isRecording ? (isPaused?'paused':'recording') : 'ready'}`;
  btnStart.disabled = isRecording;
  btnStop.disabled = !isRecording;
  btnPause.disabled = !isRecording || isPaused;
  btnResume.disabled = !isRecording || !isPaused;
  providerLabel.textContent = currentState.provider || 'Auto';
}

function manageTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  if (!currentState.isRecording) {
    timerEl.textContent = '00:00';
    return;
  }
  const tick = () => {
    const elapsed = Date.now() - currentState.startTime - (currentState.totalPausedMs || 0);
    timerEl.textContent = formatTime(elapsed);
  };
  tick();
  if (!currentState.isPaused) timerInterval = setInterval(tick, 500);
}

function setTranscript(text) {
  const atBottom = transcriptArea.scrollHeight - transcriptArea.scrollTop - transcriptArea.clientHeight < 35;
  transcriptArea.value = text || '';
  if (atBottom) transcriptArea.scrollTop = transcriptArea.scrollHeight;
  updateCounts();
}

function setInterim(text) {
  const t = (text || '').trim();
  interimHint.textContent = t ? `… ${t}` : '';
  interimHint.classList.toggle('hidden', !t);
  updateCounts();
}

function saveEditedTranscript() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ currentTranscript: transcriptArea.value, lastUpdated: Date.now() });
  }, 300);
}

function renderMeetingDetected(meeting) {
  pendingMeeting = meeting || null;
  if (!meeting || currentState.isRecording) {
    meetingDetected.classList.add('hidden');
    return;
  }

  const icons = { 'Google Meet': 'M', 'Zoom': 'Z', 'Microsoft Teams': 'T' };
  meetingDetectedIcon.textContent = icons[meeting.platform] || '•';
  meetingDetectedTitle.textContent = `${meeting.platform} meeting detected`;
  try {
    const u = new URL(meeting.url);
    meetingDetectedMeta.textContent = `${u.hostname}${u.pathname.length > 28 ? `${u.pathname.slice(0, 28)}…` : u.pathname} · Mic + meeting audio when permitted`;
  } catch {
    meetingDetectedMeta.textContent = 'Meeting tab detected · Mic + meeting audio when permitted when permitted';
  }
  meetingDetected.classList.remove('hidden');
}

function applyAuthUI(snapshot) {
  const loggedIn = Boolean(snapshot?.isLoggedIn && snapshot?.authUser);
  if (authGate) authGate.classList.toggle('hidden', loggedIn);
  if (mainApp) mainApp.classList.toggle('hidden', !loggedIn);
  if (authFooter) {
    authFooter.textContent = loggedIn
      ? `@${snapshot.authUser.username}`
      : 'Not signed in';
  }
  if (logoutLink) logoutLink.classList.toggle('hidden', !loggedIn);
  if (!loggedIn && authServerUrl && snapshot?.backendUrl) {
    authServerUrl.value = snapshot.backendUrl;
  }
  if (!loggedIn && authApiKey) {
    setTimeout(() => authApiKey.focus(), 50);
  }
}

function applySnapshot(snapshot) {
  applyAuthUI(snapshot);
  if (!snapshot?.isLoggedIn) return;
  if (!userIsEditing) setTranscript(snapshot.transcript || '');
  if (snapshot.noteTitle !== undefined && document.activeElement !== sessionTitle) {
    sessionTitle.value = snapshot.noteTitle || 'Untitled meeting';
  }
  setInterim(snapshot.interim || '');
  currentState = snapshot.recordingState || currentState;
  renderMeetingDetected(snapshot.pendingMeeting || null);
  updateUI(); manageTimer();
}

function showAuthError(msg) {
  if (!authGateError) return;
  authGateError.textContent = msg || '';
  authGateError.classList.toggle('hidden', !msg);
}

async function loadScriptMode() {
  const { transcriptScript = 'roman' } = await chrome.storage.local.get({ transcriptScript: 'roman' });
  scriptModeEl.value = transcriptScript;
}

scriptModeEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ transcriptScript: scriptModeEl.value });
});

let titleSaveTimer = null;
function saveTitle() {
  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(async () => {
    const title = sessionTitle.value.trim() || 'Untitled meeting';
    sessionTitle.value = title;
    await chrome.runtime.sendMessage({ target: 'background', type: 'SET_TITLE', title });
  }, 250);
}
sessionTitle.addEventListener('input', saveTitle);
sessionTitle.addEventListener('blur', saveTitle);
sessionTitle.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); sessionTitle.blur(); }
});

async function loadState() {
  const result = await send('GET_STATE');
  if (!result?.ok) return;
  applySnapshot(result);
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    stream.getTracks().forEach(t => t.stop());
  } catch (err) {
    btnStart.disabled = false;
    // Open the dedicated permission page (getUserMedia from popup is unreliable)
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('request-mic.html'),
        type: 'popup',
        width: 420,
        height: 380,
        focused: true
      });
      showToast('A permission window has opened. Allow the microphone, then try Start again.', {
        title: 'Microphone access needed',
        type: 'info',
        duration: 5500
      });
    } catch (_) {
      showToast(
        err.name === 'NotAllowedError'
          ? 'Please allow the microphone in chrome://settings/content/microphone, then try again.'
          : (err.message || String(err)),
        { title: 'Microphone access needed', type: 'error', duration: 6000 }
      );
    }
    return;
  }
  let tabCaptureStreamId = null;
  let captureMeetingAudio = false;

  // Remote participants come from the meeting tab's output audio. Chrome
  // only grants tabCapture in an explicit invocation context for the target
  // tab. If the user is currently working in another tab, do not attempt to
  // capture the meeting tab and do not interrupt microphone transcription.
  if (pendingMeeting?.tabId) {
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });
      if (activeTab?.id === pendingMeeting.tabId && /^https?:$/i.test(new URL(pendingMeeting.url).protocol)) {
        tabCaptureStreamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: pendingMeeting.tabId
        });
        captureMeetingAudio = Boolean(tabCaptureStreamId);
      }
    } catch (err) {
      console.info('[popup] meeting-audio capture unavailable; continuing with microphone:', err?.message || err);
      tabCaptureStreamId = null;
      captureMeetingAudio = false;
    }
  }

  const result = await send('START_RECORDING', { tabCaptureStreamId, captureMeetingAudio });
  if (!result?.ok) {
    btnStart.disabled = false;
    showToast(result?.error || 'Unable to start recording.', {
      title: 'Could not start',
      type: 'error',
      duration: 5500
    });
    return;
  }
  currentState = result.state;
  meetingDetected.classList.add('hidden');
  if (pendingMeeting && captureMeetingAudio) {
    console.log('[popup] Meeting audio capture enabled');
  }
  if (pendingMeeting) {
    await send('MEETING_TRANSCRIPTION_STARTED');
    pendingMeeting = null;
  }
  updateUI(); manageTimer();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  try {
    const result = await send('STOP_RECORDING');
    if (result?.ok) {
      currentState = { isRecording: false, isPaused: false, startTime: null, totalPausedMs: 0, provider: null };
      setInterim('');
      updateUI();
      manageTimer();
      if (result.synced) {
        showToast(
          result.analysisReady
            ? 'Meeting saved and AI summary is ready.'
            : (result.analysisError
              ? `Saved. AI analysis issue: ${result.analysisError}`
              : 'Meeting saved to MongoDB.'),
          { title: 'Recording stopped', type: result.analysisReady ? 'success' : 'info', duration: 4200 }
        );
      } else if (result.syncError) {
        showToast(`Saved locally. Sync later: ${result.syncError}`, {
          title: 'Backend offline',
          type: 'warn',
          duration: 5000
        });
      }
    } else {
      showToast(result?.error || 'Stop failed.', { title: 'Error', type: 'error' });
    }
  } finally {
    btnStop.disabled = !currentState.isRecording;
  }
});

btnPause.addEventListener('click', async () => {
  const result = await send('PAUSE_RECORDING');
  if (result?.ok) {
    currentState.isPaused = true;
    currentState.pauseTime = Date.now();
    updateUI(); manageTimer();
  }
});

btnResume.addEventListener('click', async () => {
  const result = await send('RESUME_RECORDING');
  if (result?.ok) {
    currentState.isPaused = false;
    currentState.pauseTime = null;
    updateUI(); manageTimer();
  }
});

btnNewNote.addEventListener('click', async () => {
  const ok = await showConfirm({
    title: 'Start a new note?',
    message: 'The current transcript will be cleared. This cannot be undone.',
    confirmLabel: 'Start new',
    cancelLabel: 'Keep current',
    danger: true
  });
  if (!ok) return;
  const result = await send('NEW_NOTE');
  if (result?.ok) {
    setTranscript(''); setInterim('');
    sessionTitle.value = 'Untitled meeting';
    await chrome.runtime.sendMessage({ target: 'background', type: 'SET_TITLE', title: 'Untitled meeting' });
    currentState = {isRecording:false,isPaused:false,startTime:null,totalPausedMs:0,provider:null};
    updateUI(); manageTimer();
    showToast('New note started.', { type: 'success', duration: 2200 });
  }
});

btnClear.addEventListener('click', async () => {
  const ok = await showConfirm({
    title: 'Clear transcript?',
    message: 'This will permanently remove the current notes from this session.',
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
    danger: true
  });
  if (!ok) return;
  const result = await send('CLEAR_NOTE');
  if (result?.ok) {
    setTranscript(''); setInterim('');
    showToast('Transcript cleared.', { type: 'success', duration: 2500 });
  }
});

btnCopy.addEventListener('click', async () => {
  const text = transcriptArea.value.trim();
  if (!text) {
    showToast('Nothing to copy yet.', { type: 'info', duration: 2500 });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Transcript copied to clipboard.', { type: 'success', duration: 2200 });
  } catch {
    showToast('Could not access the clipboard.', { title: 'Copy failed', type: 'error' });
  }
});

btnDownload.addEventListener('click', () => {
  const text = transcriptArea.value.trim();
  const title = sessionTitle.value.trim() || 'Untitled meeting';
  if (!text && title === 'Untitled meeting') {
    showToast('Add some notes before exporting.', { type: 'info', duration: 2500 });
    return;
  }
  const content = `${title}\n${'='.repeat(Math.min(Math.max(title.length, 10), 80))}\n\n${text}\n`;
  const blob = new Blob([content], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '-').slice(0, 80) || 'meeting-notes';
  a.href = url;
  a.download = `${safeTitle}-${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

btnSaveAnalyze.addEventListener('click', async () => {
  const text = transcriptArea.value.trim();
  const title = sessionTitle.value.trim() || 'Untitled meeting';
  if (!text) {
    showToast('Type or paste notes in the transcript box first.', {
      title: 'Nothing to save',
      type: 'info',
      duration: 3200
    });
    return;
  }

  btnSaveAnalyze.disabled = true;
  const originalLabel = btnSaveAnalyze.innerHTML;
  btnSaveAnalyze.innerHTML = '<span class="btn-icon">…</span> Saving…';

  try {
    // Persist any in-progress edits before save
    await chrome.storage.local.set({
      currentTranscript: text,
      noteTitle: title,
      lastUpdated: Date.now()
    });

    const result = await send('SAVE_AND_ANALYZE', {
      transcript: text,
      title,
      platform: pendingMeeting?.platform || 'Manual'
    });

    if (!result?.ok) {
      showToast(result?.error || 'Could not save to the backend.', {
        title: 'Save failed',
        type: 'error',
        duration: 5500
      });
      return;
    }

    if (result.synced) {
      const aiNote = result.analysisReady
        ? 'AI summary is ready.'
        : (result.analysisError
          ? `Saved, but AI analysis failed: ${result.analysisError}`
          : 'Saved. AI analysis may still be processing.');
      showToast(aiNote, {
        title: 'Saved to MongoDB',
        type: result.analysisReady ? 'success' : 'warn',
        duration: 4500
      });
    } else {
      showToast(
        result.syncError
          ? `Queued offline. Will retry when the server is back. (${result.syncError})`
          : 'Queued offline. Start the server to sync.',
        { title: 'Saved locally', type: 'warn', duration: 5500 }
      );
    }
  } catch (err) {
    showToast(err.message || String(err), { title: 'Save failed', type: 'error', duration: 5000 });
  } finally {
    btnSaveAnalyze.disabled = false;
    btnSaveAnalyze.innerHTML = originalLabel;
  }
});

transcriptArea.addEventListener('focus', () => userIsEditing = true);
transcriptArea.addEventListener('blur', () => { userIsEditing = false; saveEditedTranscript(); });
transcriptArea.addEventListener('input', () => { updateCounts(); saveEditedTranscript(); });

meetingDismiss.addEventListener('click', async () => {
  await send('DISMISS_MEETING_PROMPT');
  pendingMeeting = null;
  meetingDetected.classList.add('hidden');
});

dashboardLink.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await chrome.tabs.create({ url: 'http://localhost:4000/' });
  } catch (error) {
    showToast(error.message || String(error), { title: 'Could not open dashboard', type: 'error' });
  }
});
optionsLink.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingMeeting) {
    renderMeetingDetected(changes.pendingMeeting.newValue || null);
    return;
  }
  if (area !== 'local') return;
  if (changes.currentTranscript && !userIsEditing) setTranscript(changes.currentTranscript.newValue || '');
  if (changes.noteTitle && document.activeElement !== sessionTitle) sessionTitle.value = changes.noteTitle.newValue || 'Untitled meeting';
  if (changes.interimTranscript) setInterim(changes.interimTranscript.newValue || '');
  if (changes.recordingState) {
    currentState = changes.recordingState.newValue || currentState;
    updateUI(); manageTimer();
  }
});

async function ensureMicrophonePermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: 'microphone' });
      if (status.state === 'granted') return true;
    }
  } catch (_) {}

  // getUserMedia from the short-lived popup often fails with NotAllowedError
  // without ever showing Chrome's permission dialog. Opening a normal window
  // is the reliable way to trigger the system prompt.
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('request-mic.html'),
      type: 'popup',
      width: 420,
      height: 380,
      focused: true
    });
  } catch (err) {
    console.warn('[popup] Could not open microphone permission window:', err);
  }
  return false;
}

btnSaveApiKey?.addEventListener('click', async () => {
  const apiKey = (authApiKey?.value || '').trim();
  const serverUrl = (authServerUrl?.value || '').trim().replace(/\/$/, '') || 'http://localhost:4000';
  if (!apiKey) {
    showAuthError('Paste your API key from the web account page.');
    return;
  }
  showAuthError('');
  btnSaveApiKey.disabled = true;
  const prevLabel = btnSaveApiKey.textContent;
  btnSaveApiKey.textContent = 'Connecting…';
  try {
    const result = await send('SET_API_KEY', { apiKey, serverUrl });
    if (!result?.ok) {
      showAuthError(result?.error || 'Could not connect. Check server and API key.');
      return;
    }
    showToast(`Connected as @${result.user?.username || 'user'}`, { type: 'success', duration: 2500 });
    await loadState();
  } finally {
    btnSaveApiKey.disabled = false;
    btnSaveApiKey.textContent = prevLabel;
  }
});

btnOpenWebAuth?.addEventListener('click', async () => {
  const result = await send('OPEN_CLIENT_AUTH');
  if (!result?.ok) {
    showAuthError(result?.error || 'Could not open http://localhost:4000 — is the server running?');
  }
});
logoutLink?.addEventListener('click', async (e) => {
  e.preventDefault();
  await send('AUTH_LOGOUT');
  showToast('Signed out.', { type: 'info', duration: 2000 });
  await loadState();
});

loadScriptMode();
loadState();
// Open the reliable microphone permission window when the extension is opened
ensureMicrophonePermission();
