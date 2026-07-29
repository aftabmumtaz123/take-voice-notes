/**
 * options.js
 * Options page – store API key and language preference.
 * Never logs the actual key value.
 */

import { getApiKey, setApiKey, getLanguage, setLanguage } from './storage.js';

console.log('[options.js] Script loaded at', new Date().toISOString());

const apiKeyInput = document.getElementById('apiKeyInput');
const btnToggleVisibility = document.getElementById('btnToggleVisibility');
const btnSave = document.getElementById('btnSave');
const btnClearKey = document.getElementById('btnClearKey');
const statusMessage = document.getElementById('statusMessage');

const languageSelect = document.getElementById('languageSelect');
const btnSaveLanguage = document.getElementById('btnSaveLanguage');
const languageStatus = document.getElementById('languageStatus');

/**
 * Show a transient status message.
 * @param {HTMLElement} el
 * @param {string} text
 * @param {'success'|'error'|''} type
 */
function showStatus(el, text, type = '') {
  console.log('[options.js] Status:', type, text);
  el.textContent = text;
  el.className = 'status' + (type ? ` ${type}` : '');
  if (text) {
    setTimeout(() => {
      el.textContent = '';
      el.className = 'status';
    }, 4000);
  }
}

/**
 * Load the currently stored key.
 */
async function loadKey() {
  console.log('[options.js] loadKey()');
  try {
    const key = await getApiKey();
    if (key) {
      apiKeyInput.value = key;
      apiKeyInput.type = 'password';
      console.log('[options.js] Key loaded (length=', key.length, ')');
    } else {
      apiKeyInput.value = '';
      console.log('[options.js] No key stored');
    }
  } catch (err) {
    console.error('[options.js] loadKey error:', err);
    showStatus(statusMessage, 'Failed to load saved key', 'error');
  }
}

/**
 * Load language preference.
 */
async function loadLanguage() {
  console.log('[options.js] loadLanguage()');
  try {
    const lang = await getLanguage();
    languageSelect.value = lang || 'multi';
    console.log('[options.js] Language loaded:', languageSelect.value);
  } catch (err) {
    console.error('[options.js] loadLanguage error:', err);
  }
}

// Toggle password visibility
btnToggleVisibility.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  btnToggleVisibility.textContent = isPassword ? '🙈' : '👁';
  console.log('[options.js] Visibility toggled, now=', apiKeyInput.type);
});

// Save API key
btnSave.addEventListener('click', async () => {
  console.log('[options.js] Save key clicked');
  const value = apiKeyInput.value.trim();
  if (!value) {
    showStatus(statusMessage, 'Please enter an API key', 'error');
    return;
  }
  if (value.length < 20) {
    showStatus(statusMessage, 'That does not look like a valid Deepgram API key', 'error');
    return;
  }

  try {
    await setApiKey(value);
    showStatus(statusMessage, 'API key saved successfully', 'success');
    console.log('[options.js] Key saved (length=', value.length, ')');
  } catch (err) {
    console.error('[options.js] Save error:', err);
    showStatus(statusMessage, 'Failed to save key: ' + (err.message || err), 'error');
  }
});

// Clear key
btnClearKey.addEventListener('click', async () => {
  console.log('[options.js] Clear key clicked');
  if (!confirm('Remove the stored Deepgram API key?')) return;
  try {
    await setApiKey('');
    apiKeyInput.value = '';
    showStatus(statusMessage, 'API key cleared', 'success');
  } catch (err) {
    console.error('[options.js] Clear error:', err);
    showStatus(statusMessage, 'Failed to clear key', 'error');
  }
});

// Save language
btnSaveLanguage.addEventListener('click', async () => {
  const lang = languageSelect.value;
  console.log('[options.js] Save language clicked:', lang);
  try {
    await setLanguage(lang);
    showStatus(languageStatus, 'Language saved. Restart recording to apply.', 'success');
  } catch (err) {
    console.error('[options.js] Save language error:', err);
    showStatus(languageStatus, 'Failed to save language', 'error');
  }
});

// Init
document.addEventListener('DOMContentLoaded', () => {
  console.log('[options.js] DOMContentLoaded');
  loadKey();
  loadLanguage();
});

console.log('[options.js] Ready');
