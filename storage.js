/**
 * storage.js
 * Shared helpers for chrome.storage.local used by background, popup, and options.
 * All operations are async and include detailed console debugging.
 */

console.log('[storage.js] Module loaded');

const STORAGE_KEYS = {
  API_KEY: 'deepgramApiKey',
  LANGUAGE: 'deepgramLanguage',
  RECORDING_STATE: 'recordingState',
  TRANSCRIPT: 'currentTranscript',
  INTERIM: 'interimTranscript',
  NOTE_TITLE: 'noteTitle',
  LAST_UPDATED: 'lastUpdated'
};

/** Allowed language modes for the Deepgram listen URL */
export const LANGUAGE_OPTIONS = {
  en: { label: 'English', model: 'nova-3', language: 'en' },
  ur: { label: 'Urdu', model: 'nova-3', language: 'ur' },
  multi: { label: 'Mixed (code-switch)', model: 'nova-3', language: 'multi' }
};

/**
 * Default recording state shape.
 */
const DEFAULT_STATE = {
  isRecording: false,
  isPaused: false,
  startTime: null,
  pauseTime: null,
  totalPausedMs: 0
};

/**
 * Get the stored Deepgram API key.
 * @returns {Promise<string|null>}
 */
export async function getApiKey() {
  console.log('[storage.js] getApiKey() called');
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
    const key = result[STORAGE_KEYS.API_KEY] || null;
    console.log('[storage.js] getApiKey() result:', key ? `[REDACTED length=${key.length}]` : 'null');
    return key;
  } catch (err) {
    console.error('[storage.js] getApiKey() error:', err);
    return null;
  }
}

/**
 * Get selected language mode: 'en' | 'ur' | 'multi'
 * @returns {Promise<string>}
 */
export async function getLanguage() {
  console.log('[storage.js] getLanguage() called');
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.LANGUAGE);
    const lang = result[STORAGE_KEYS.LANGUAGE] || 'multi';
    console.log('[storage.js] getLanguage() result:', lang);
    return lang;
  } catch (err) {
    console.error('[storage.js] getLanguage() error:', err);
    return 'multi';
  }
}

/**
 * Save language mode.
 * @param {string} lang - 'en' | 'ur' | 'multi'
 * @returns {Promise<void>}
 */
export async function setLanguage(lang) {
  console.log('[storage.js] setLanguage() called:', lang);
  try {
    if (!LANGUAGE_OPTIONS[lang]) {
      throw new Error('Invalid language: ' + lang);
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LANGUAGE]: lang });
    console.log('[storage.js] setLanguage() success');
  } catch (err) {
    console.error('[storage.js] setLanguage() error:', err);
    throw err;
  }
}

/**
 * Save the Deepgram API key.
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
export async function setApiKey(apiKey) {
  console.log('[storage.js] setApiKey() called, length=', apiKey ? apiKey.length : 0);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: apiKey });
    console.log('[storage.js] setApiKey() success');
  } catch (err) {
    console.error('[storage.js] setApiKey() error:', err);
    throw err;
  }
}

/**
 * Get the current recording state.
 * @returns {Promise<object>}
 */
export async function getRecordingState() {
  console.log('[storage.js] getRecordingState() called');
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.RECORDING_STATE);
    const state = result[STORAGE_KEYS.RECORDING_STATE] || { ...DEFAULT_STATE };
    console.log('[storage.js] getRecordingState() result:', JSON.stringify(state));
    return state;
  } catch (err) {
    console.error('[storage.js] getRecordingState() error:', err);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Update recording state (merges with existing).
 * @param {object} partial
 * @returns {Promise<object>} The new full state
 */
export async function setRecordingState(partial) {
  console.log('[storage.js] setRecordingState() called with:', JSON.stringify(partial));
  try {
    const current = await getRecordingState();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDING_STATE]: next });
    console.log('[storage.js] setRecordingState() saved:', JSON.stringify(next));
    return next;
  } catch (err) {
    console.error('[storage.js] setRecordingState() error:', err);
    throw err;
  }
}

/**
 * Get the current final transcript text.
 * @returns {Promise<string>}
 */
export async function getTranscript() {
  console.log('[storage.js] getTranscript() called');
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.TRANSCRIPT);
    const text = result[STORAGE_KEYS.TRANSCRIPT] || '';
    console.log('[storage.js] getTranscript() length=', text.length);
    return text;
  } catch (err) {
    console.error('[storage.js] getTranscript() error:', err);
    return '';
  }
}

/**
 * Set the final transcript text.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function setTranscript(text) {
  console.log('[storage.js] setTranscript() called, length=', text ? text.length : 0);
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.TRANSCRIPT]: text || '',
      [STORAGE_KEYS.LAST_UPDATED]: Date.now()
    });
    console.log('[storage.js] setTranscript() success');
  } catch (err) {
    console.error('[storage.js] setTranscript() error:', err);
    throw err;
  }
}

/**
 * Get the current interim (non-final) transcript.
 * @returns {Promise<string>}
 */
export async function getInterim() {
  console.log('[storage.js] getInterim() called');
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.INTERIM);
    return result[STORAGE_KEYS.INTERIM] || '';
  } catch (err) {
    console.error('[storage.js] getInterim() error:', err);
    return '';
  }
}

/**
 * Set the interim transcript.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function setInterim(text) {
  console.log('[storage.js] setInterim() called, length=', text ? text.length : 0);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.INTERIM]: text || '' });
  } catch (err) {
    console.error('[storage.js] setInterim() error:', err);
  }
}

/**
 * Clear all transcript-related data and reset recording state.
 * @returns {Promise<void>}
 */
export async function clearNote() {
  console.log('[storage.js] clearNote() called');
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.TRANSCRIPT]: '',
      [STORAGE_KEYS.INTERIM]: '',
      [STORAGE_KEYS.NOTE_TITLE]: '',
      [STORAGE_KEYS.RECORDING_STATE]: { ...DEFAULT_STATE },
      [STORAGE_KEYS.LAST_UPDATED]: Date.now()
    });
    console.log('[storage.js] clearNote() success');
  } catch (err) {
    console.error('[storage.js] clearNote() error:', err);
    throw err;
  }
}

/**
 * Get a full snapshot of note-related storage.
 * @returns {Promise<object>}
 */
export async function getNoteSnapshot() {
  console.log('[storage.js] getNoteSnapshot() called');
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.TRANSCRIPT,
      STORAGE_KEYS.INTERIM,
      STORAGE_KEYS.NOTE_TITLE,
      STORAGE_KEYS.RECORDING_STATE,
      STORAGE_KEYS.LAST_UPDATED
    ]);
    const snapshot = {
      transcript: result[STORAGE_KEYS.TRANSCRIPT] || '',
      interim: result[STORAGE_KEYS.INTERIM] || '',
      noteTitle: result[STORAGE_KEYS.NOTE_TITLE] || '',
      recordingState: result[STORAGE_KEYS.RECORDING_STATE] || { ...DEFAULT_STATE },
      lastUpdated: result[STORAGE_KEYS.LAST_UPDATED] || null
    };
    console.log('[storage.js] getNoteSnapshot() transcript length=', snapshot.transcript.length);
    return snapshot;
  } catch (err) {
    console.error('[storage.js] getNoteSnapshot() error:', err);
    return {
      transcript: '',
      interim: '',
      noteTitle: '',
      recordingState: { ...DEFAULT_STATE },
      lastUpdated: null
    };
  }
}

console.log('[storage.js] Module ready, STORAGE_KEYS:', Object.keys(STORAGE_KEYS));
