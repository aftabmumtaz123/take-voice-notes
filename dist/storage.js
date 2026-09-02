const STORAGE_KEYS = {
  RECORDING_STATE: 'recordingState',
  TRANSCRIPT: 'currentTranscript',
  INTERIM: 'interimTranscript',
  NOTE_TITLE: 'noteTitle',
  LAST_UPDATED: 'lastUpdated',
  ACTIVE_PROVIDER: 'activeProvider'
};

const DEFAULT_STATE = {
  isRecording: false,
  isPaused: false,
  startTime: null,
  pauseTime: null,
  totalPausedMs: 0,
  provider: null
};

export const PROVIDERS = {
  deepgram: { label: 'Deepgram', kind: 'live' },
  assemblyai: { label: 'AssemblyAI', kind: 'live' },
  openai: { label: 'OpenAI', kind: 'chunked' }
};

export async function getRecordingState() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RECORDING_STATE);
  return result[STORAGE_KEYS.RECORDING_STATE] || { ...DEFAULT_STATE };
}

export async function setRecordingState(partial) {
  const current = await getRecordingState();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.RECORDING_STATE]: next });
  return next;
}

export async function getTranscript() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.TRANSCRIPT);
  return result[STORAGE_KEYS.TRANSCRIPT] || '';
}

export async function setTranscript(text) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRANSCRIPT]: text || '',
    [STORAGE_KEYS.LAST_UPDATED]: Date.now()
  });
}

export async function getInterim() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.INTERIM);
  return result[STORAGE_KEYS.INTERIM] || '';
}

export async function setInterim(text) {
  await chrome.storage.local.set({ [STORAGE_KEYS.INTERIM]: text || '' });
}

export async function clearNote() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRANSCRIPT]: '',
    [STORAGE_KEYS.INTERIM]: '',
    [STORAGE_KEYS.NOTE_TITLE]: '',
    [STORAGE_KEYS.RECORDING_STATE]: { ...DEFAULT_STATE },
    [STORAGE_KEYS.LAST_UPDATED]: Date.now()
  });
}

export async function getNoteSnapshot() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.TRANSCRIPT,
    STORAGE_KEYS.INTERIM,
    STORAGE_KEYS.NOTE_TITLE,
    STORAGE_KEYS.RECORDING_STATE,
    STORAGE_KEYS.LAST_UPDATED
  ]);
  return {
    transcript: result[STORAGE_KEYS.TRANSCRIPT] || '',
    interim: result[STORAGE_KEYS.INTERIM] || '',
    noteTitle: result[STORAGE_KEYS.NOTE_TITLE] || '',
    recordingState: result[STORAGE_KEYS.RECORDING_STATE] || { ...DEFAULT_STATE },
    lastUpdated: result[STORAGE_KEYS.LAST_UPDATED] || null
  };
}

export async function getActiveProviderOverride() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_PROVIDER);
  return result[STORAGE_KEYS.ACTIVE_PROVIDER] || null;
}

export async function setActiveProviderOverride(provider) {
  if (provider && !PROVIDERS[provider]) throw new Error('Invalid provider');
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_PROVIDER]: provider || '' });
}
