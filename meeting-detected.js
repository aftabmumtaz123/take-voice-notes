const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const platform = params.get('platform') || 'Meeting';
const url = params.get('url') || '';
const tabId = Number(params.get('tabId'));

const platformName = $('platformName');
const platformIcon = $('platformIcon');
const meetingUrl = $('meetingUrl');
const startBtn = $('startBtn');
const laterBtn = $('laterBtn');
const errorEl = $('error');
const description = $('meetingDescription');

const iconLetters = {
  'Google Meet': 'M',
  'Zoom': 'Z',
  'Microsoft Teams': 'T'
};

platformName.textContent = platform;
platformIcon.textContent = iconLetters[platform] || 'M';
meetingUrl.textContent = compactUrl(url);
description.textContent = `${platform} was detected in your active browser tab. Start when you're ready.`;

autoCloseIfInvalid();

function compactUrl(value) {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.length > 30 ? `${parsed.pathname.slice(0, 30)}…` : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return value || 'Meeting link detected';
  }
}

async function send(type) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ target: 'background', type, tabId }, resolve));
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
  startBtn.disabled = false;
}

async function requestMicrophonePermission() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false
  });
  stream.getTracks().forEach((track) => track.stop());
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  errorEl.classList.add('hidden');
  startBtn.innerHTML = '<span>◌</span> Requesting microphone…';

  try {
    await requestMicrophonePermission();
    startBtn.innerHTML = '<span>●</span> Starting transcription…';
    const result = await send('START_RECORDING');
    if (!result?.ok) throw new Error(result?.error || 'Unable to start transcription.');

    await send('MEETING_TRANSCRIPTION_STARTED');
    startBtn.textContent = '✓ Transcription started';
    setTimeout(() => window.close(), 700);
  } catch (err) {
    const message = err?.name === 'NotAllowedError'
      ? 'Microphone permission was denied. Allow microphone access for AI Note Taker and try again.'
      : (err?.message || 'Unable to start transcription.');
    showError(message);
    startBtn.innerHTML = '<span>●</span> Start transcription';
  }
});

laterBtn.addEventListener('click', async () => {
  await send('DISMISS_MEETING_PROMPT');
  window.close();
});

function autoCloseIfInvalid() {
  if (!Number.isInteger(tabId) || tabId < 0 || !url) {
    startBtn.disabled = true;
    showError('This meeting prompt is no longer valid.');
  }
}
