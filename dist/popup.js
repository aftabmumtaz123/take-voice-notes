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
const optionsLink = $('optionsLink');
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
    meetingDetectedMeta.textContent = `${u.hostname}${u.pathname.length > 28 ? `${u.pathname.slice(0, 28)}…` : u.pathname} · Mic + meeting audio`;
  } catch {
    meetingDetectedMeta.textContent = 'Meeting tab detected · Mic + meeting audio';
  }
  meetingDetected.classList.remove('hidden');
}

function applySnapshot(snapshot) {
  if (!userIsEditing) setTranscript(snapshot.transcript || '');
  if (snapshot.noteTitle !== undefined && document.activeElement !== sessionTitle) {
    sessionTitle.value = snapshot.noteTitle || 'Untitled meeting';
  }
  setInterim(snapshot.interim || '');
  currentState = snapshot.recordingState || currentState;
  renderMeetingDetected(snapshot.pendingMeeting || null);
  updateUI(); manageTimer();
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
    alert(err.name === 'NotAllowedError' ? 'Microphone permission is required to record.' : `Microphone error: ${err.message || err}`);
    return;
  }
  let tabCaptureStreamId = null;
  let captureMeetingAudio = false;

  // A meeting's remote participants are delivered through the meeting tab's
  // audio. Chrome requires tabCapture to follow an extension user invocation,
  // so this is intentionally performed from the Start button click.
  if (pendingMeeting?.tabId) {
    try {
      tabCaptureStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: pendingMeeting.tabId
      });
      captureMeetingAudio = Boolean(tabCaptureStreamId);
    } catch (err) {
      console.warn('[popup] meeting audio capture unavailable:', err);
      const proceed = confirm('Meeting audio could not be captured. Start microphone-only transcription instead?');
      if (!proceed) {
        btnStart.disabled = false;
        return;
      }
    }
  }

  const result = await send('START_RECORDING', { tabCaptureStreamId, captureMeetingAudio });
  if (!result?.ok) {
    btnStart.disabled = false;
    alert(result?.error || 'Unable to start recording.');
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
  const result = await send('STOP_RECORDING');
  if (result?.ok) {
    currentState = {isRecording:false,isPaused:false,startTime:null,totalPausedMs:0,provider:null};
    setInterim(''); updateUI(); manageTimer();
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
  if (!confirm('Start a new note? The current transcript will be cleared.')) return;
  const result = await send('NEW_NOTE');
  if (result?.ok) {
    setTranscript(''); setInterim('');
    sessionTitle.value = 'Untitled meeting';
    await chrome.runtime.sendMessage({ target: 'background', type: 'SET_TITLE', title: 'Untitled meeting' });
    currentState = {isRecording:false,isPaused:false,startTime:null,totalPausedMs:0,provider:null};
    updateUI(); manageTimer();
  }
});

btnClear.addEventListener('click', async () => {
  if (!confirm('Clear the current transcript?')) return;
  const result = await send('CLEAR_NOTE');
  if (result?.ok) { setTranscript(''); setInterim(''); }
});

btnCopy.addEventListener('click', async () => {
  const text = transcriptArea.value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const old = btnCopy.textContent;
  btnCopy.textContent = 'Copied';
  setTimeout(() => btnCopy.textContent = old, 1200);
});

btnDownload.addEventListener('click', () => {
  const text = transcriptArea.value.trim();
  const title = sessionTitle.value.trim() || 'Untitled meeting';
  if (!text && title === 'Untitled meeting') return;
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

transcriptArea.addEventListener('focus', () => userIsEditing = true);
transcriptArea.addEventListener('blur', () => { userIsEditing = false; saveEditedTranscript(); });
transcriptArea.addEventListener('input', () => { updateCounts(); saveEditedTranscript(); });

meetingDismiss.addEventListener('click', async () => {
  await send('DISMISS_MEETING_PROMPT');
  pendingMeeting = null;
  meetingDetected.classList.add('hidden');
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

loadScriptMode();
loadState();
