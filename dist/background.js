import './runtime-config.js';
import { toRoman } from './script-processor.js';
import {
  getRecordingState, setRecordingState, getTranscript, setTranscript,
  setInterim, clearNote, getNoteSnapshot
} from './storage.js';

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASON = 'USER_MEDIA';
const OFFSCREEN_JUSTIFICATION = 'Continuous microphone capture for real-time AI transcription.';
const MEETING_COOLDOWN_MS = 30 * 60 * 1000;

let creating = null;
let bootResolver = null;

const MEETING_DETECTORS = [
  {
    name: 'Google Meet',
    test(url) {
      try {
        const u = new URL(url);
        return u.protocol === 'https:' && u.hostname === 'meet.google.com' && /^\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}(?:[/?#]|$)/i.test(u.pathname);
      } catch { return false; }
    }
  },
  {
    name: 'Zoom',
    test(url) {
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol) || !/(^|\.)zoom\.us$/i.test(u.hostname)) return false;
        return /^\/(?:j\/\d+|wc\/join\/|my\/|meeting\/)/i.test(u.pathname);
      } catch { return false; }
    }
  },
  {
    name: 'Microsoft Teams',
    test(url) {
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return false;
        const host = u.hostname.toLowerCase();
        if (!(host === 'teams.microsoft.com' || host === 'teams.live.com' || host.endsWith('.teams.microsoft.com'))) return false;
        return /\/l\/meetup-join\//i.test(u.pathname + u.search);
      } catch { return false; }
    }
  }
];

function detectMeeting(url) {
  if (!url) return null;
  return MEETING_DETECTORS.find((detector) => detector.test(url)) || null;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch (err) {
    console.warn('[background] close offscreen:', err);
  }
}

async function ensureOffscreen() {
  await closeOffscreenDocument();
  if (creating) return creating;

  const boot = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bootResolver = null;
      reject(new Error('Transcription engine did not start in time'));
    }, 8000);
    bootResolver = () => {
      clearTimeout(timeout);
      bootResolver = null;
      resolve();
    };
  });

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification: OFFSCREEN_JUSTIFICATION
  }).then(() => boot).finally(() => { creating = null; });

  return creating;
}

async function sendToOffscreen(type) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type });
}

async function configuredProviders() {
  const config = globalThis.AI_NOTE_CONFIG || {};
  return (config.fallbackProviders || [config.activeProvider])
    .filter(name => config.keys?.[name]);
}

async function getMeetingState() {
  return chrome.storage.session.get({ pendingMeeting: null, meetingPromptHistory: {} });
}

async function markMeetingDetected(tabId, url) {
  const key = `${tabId}:${url}`;
  const state = await getMeetingState();
  const history = { ...(state.meetingPromptHistory || {}) };
  history[key] = Date.now();
  const cutoff = Date.now() - MEETING_COOLDOWN_MS;
  for (const [entry, timestamp] of Object.entries(history)) {
    if (timestamp < cutoff) delete history[entry];
  }
  await chrome.storage.session.set({ meetingPromptHistory: history });
}

async function wasMeetingRecentlyDetected(tabId, url) {
  const state = await getMeetingState();
  const timestamp = state.meetingPromptHistory?.[`${tabId}:${url}`];
  return Boolean(timestamp && Date.now() - timestamp < MEETING_COOLDOWN_MS);
}

async function startRecordingInternal({ automatic = false } = {}) {
  const providers = await configuredProviders();
  if (!providers.length) {
    throw new Error('No transcription provider is configured. Add developer API keys to .env and run npm run build.');
  }

  await ensureOffscreen();
  await setInterim('');
  await setRecordingState({
    isRecording: true, isPaused: false, startTime: Date.now(),
    pauseTime: null, totalPausedMs: 0, provider: null
  });

  const result = await sendToOffscreen('OFFSCREEN_START');
  if (!result?.ok) {
    await setRecordingState({ isRecording: false, isPaused: false, provider: null });
    await closeOffscreenDocument();
    throw new Error(result?.error || 'Unable to start transcription');
  }

  const finalState = await setRecordingState({ provider: result.provider || null });
  if (automatic) console.log('[background] Automatic meeting transcription started:', finalState.provider);
  return finalState;
}

async function openExtensionPopup(tab) {
  if (!tab?.id || !tab?.windowId || !tab.url) return;
  const detector = detectMeeting(tab.url);
  if (!detector) return;

  const recording = await getRecordingState();
  if (recording?.isRecording) return;
  if (await wasMeetingRecentlyDetected(tab.id, tab.url)) return;

  const pendingMeeting = {
    platform: detector.name,
    url: tab.url,
    tabId: tab.id,
    windowId: tab.windowId,
    detectedAt: Date.now()
  };

  await chrome.storage.session.set({ pendingMeeting });
  await markMeetingDetected(tab.id, tab.url);

  // Try to start immediately. If microphone permission has already been granted
  // for the extension, transcription starts without requiring a click. On a
  // first run Chrome may require an explicit user gesture for microphone access;
  // in that case we open the popup and the existing Start button completes it.
  try {
    await startRecordingInternal({ automatic: true });
    await chrome.storage.session.remove('pendingMeeting');
  } catch (err) {
    console.warn('[background] automatic meeting transcription could not start:', err);
  }

  // Show the normal extension UI so the user can see the detected meeting and,
  // when first-time microphone permission is required, click Start recording.
  if (typeof chrome.action?.openPopup === 'function') {
    try {
      await chrome.action.openPopup({ windowId: tab.windowId });
      return;
    } catch (err) {
      console.warn('[background] action.openPopup failed:', err);
    }
  }

  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#8b7cff' });
  } catch {}
}

async function scanTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (detectMeeting(tab.url)) {
        await openExtensionPopup(tab);
        break;
      }
    }
  } catch (err) {
    console.warn('[background] tab scan:', err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && detectMeeting(tab.url)) {
    openExtensionPopup(tab).catch(err => console.warn('[background] detect:', err));
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (detectMeeting(tab.url)) await openExtensionPopup(tab);
  } catch (err) {
    console.warn('[background] activation detect:', err);
  }
});

chrome.runtime.onInstalled.addListener(() => { scanTabs(); });
chrome.runtime.onStartup.addListener(() => { scanTabs(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== 'background') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'GET_STATE': {
          const snapshot = await getNoteSnapshot();
          const providers = await configuredProviders();
          const meetingState = await getMeetingState();
          sendResponse({
            ok: true, ...snapshot,
            pendingMeeting: meetingState.pendingMeeting || null,
            activeProvider: globalThis.AI_NOTE_CONFIG?.activeProvider || 'assemblyai',
            configuredProviders: providers
          });
          break;
        }

        case 'START_RECORDING': {
          try {
            const finalState = await startRecordingInternal({ automatic: false });
            sendResponse({ ok: true, state: finalState });
          } catch (err) {
            sendResponse({ ok: false, error: err.message || String(err) });
          }
          break;
        }

        case 'STOP_RECORDING':
          try { await sendToOffscreen('OFFSCREEN_STOP'); } catch {}
          await setRecordingState({ isRecording: false, isPaused: false, startTime: null, pauseTime: null, totalPausedMs: 0, provider: null });
          await setInterim('');
          await closeOffscreenDocument();
          sendResponse({ ok: true });
          break;

        case 'PAUSE_RECORDING':
          await sendToOffscreen('OFFSCREEN_PAUSE');
          await setRecordingState({ isPaused: true, pauseTime: Date.now() });
          sendResponse({ ok: true });
          break;

        case 'RESUME_RECORDING': {
          const current = await getRecordingState();
          let totalPausedMs = current.totalPausedMs || 0;
          if (current.pauseTime) totalPausedMs += Date.now() - current.pauseTime;
          await sendToOffscreen('OFFSCREEN_RESUME');
          await setRecordingState({ isPaused: false, pauseTime: null, totalPausedMs });
          sendResponse({ ok: true });
          break;
        }

        case 'NEW_NOTE': {
          const state = await getRecordingState();
          if (state.isRecording) {
            try { await sendToOffscreen('OFFSCREEN_STOP'); } catch {}
            await closeOffscreenDocument();
          }
          await clearNote();
          sendResponse({ ok: true });
          break;
        }

        case 'SET_TITLE': {
          const title = String(message.title || '').trim().slice(0, 120) || 'Untitled meeting';
          await chrome.storage.local.set({ noteTitle: title, lastUpdated: Date.now() });
          sendResponse({ ok: true, title });
          break;
        }

        case 'CLEAR_NOTE':
          await setTranscript('');
          await setInterim('');
          sendResponse({ ok: true });
          break;

        case 'TRANSCRIPT_UPDATE': {
          const result = await chrome.storage.local.get({ transcriptScript: 'roman' });
          const scriptMode = result.transcriptScript || 'roman';
          const addition = toRoman((message.transcript || '').trim(), scriptMode).trim();
          if (!addition) { sendResponse({ ok: true }); break; }
          if (message.is_final) {
            const existing = await getTranscript();
            const separator = existing && !/[ \n]$/.test(existing) ? ' ' : '';
            await setTranscript(existing + separator + addition);
            await setInterim('');
          } else {
            await setInterim(addition);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'OFFSCREEN_ERROR':
          await setRecordingState({ isRecording: false, isPaused: false });
          await setInterim('');
          sendResponse({ ok: true, error: message.error });
          break;

        case 'OFFSCREEN_BOOTED':
          bootResolver?.();
          sendResponse({ ok: true });
          break;

        case 'OFFSCREEN_READY':
          await setRecordingState({ provider: message.provider || null });
          sendResponse({ ok: true });
          break;

        case 'DISMISS_MEETING_PROMPT':
          await chrome.storage.session.remove('pendingMeeting');
          sendResponse({ ok: true });
          break;

        case 'MEETING_TRANSCRIPTION_STARTED': {
          const meetingState = await getMeetingState();
          const meeting = meetingState.pendingMeeting;
          if (Number.isInteger(message.tabId)) {
            try { await chrome.tabs.update(message.tabId, { active: true }); } catch {}
          } else if (Number.isInteger(meeting?.tabId)) {
            try { await chrome.tabs.update(meeting.tabId, { active: true }); } catch {}
          }
          await chrome.storage.session.remove('pendingMeeting');
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[background] error:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});
