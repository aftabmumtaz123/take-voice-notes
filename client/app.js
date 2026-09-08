const API = localStorage.getItem('apiUrl') || 'http://localhost:4000';
const CLIENT_ORIGIN = window.location.origin;

const $ = (id) => document.getElementById(id);
const authView = $('authView');
const appView = $('appView');
const authError = $('authError');
const loginForm = $('loginForm');
const registerForm = $('registerForm');
const meetingList = $('meetingList');
const detailPane = $('detailPane');
const whoami = $('whoami');
const searchInput = $('searchInput');
const toastEl = $('toast');

let token = localStorage.getItem('authToken') || '';
let user = null;
let meetings = [];
let activeId = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  setTimeout(() => toastEl.classList.add('hidden'), 2800);
}

function showError(msg) {
  authError.textContent = msg || '';
  authError.classList.toggle('hidden', !msg);
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function setSession({ token: t, user: u }) {
  token = t || '';
  user = u || null;
  if (token) localStorage.setItem('authToken', token);
  else localStorage.removeItem('authToken');
  if (user) localStorage.setItem('authUser', JSON.stringify(user));
  else localStorage.removeItem('authUser');
}

function showAuth() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
}

function showApp() {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  whoami.textContent = user ? `@${user.username}` : '';
}

// Tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    loginForm.classList.toggle('hidden', tab !== 'login');
    registerForm.classList.toggle('hidden', tab !== 'register');
    showError('');
  });
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('loginUsername').value.trim(),
        passkey: $('loginPasskey').value,
        label: 'web'
      })
    });
    setSession({ token: data.token, user: data.user });
    showApp();
    await loadMeetings();
    toast(`Welcome back, @${data.user.username}`);
    // Notify extension if opened from extension redirect
    maybeNotifyExtension();
  } catch (err) {
    showError(err.message);
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const pass = $('regPasskey').value;
  if (pass !== $('regPasskey2').value) {
    showError('Passkeys do not match.');
    return;
  }
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('regUsername').value.trim(),
        passkey: pass,
        displayName: $('regDisplay').value.trim()
      })
    });
    setSession({ token: data.token, user: data.user });
    showApp();
    await loadMeetings();
    toast(`Account created: @${data.user.username}`);
    maybeNotifyExtension();
  } catch (err) {
    showError(err.message);
  }
});

$('btnLogout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ token }) }); } catch (_) {}
  setSession({ token: '', user: null });
  meetings = [];
  showAuth();
});

function maybeNotifyExtension() {
  // If opened with ?from=extension, store a flag the extension can poll via shared origin isn't possible;
  // extension uses its own storage. User logs in inside extension popup separately or via deep link message.
  const params = new URLSearchParams(location.search);
  if (params.get('from') === 'extension') {
    toast('Account ready — return to the extension and log in with the same username.');
  }
}

async function loadMeetings() {
  meetingList.innerHTML = '<div class="loading">Loading meetings…</div>';
  try {
    const q = searchInput.value.trim();
    const data = await api(`/api/meetings?q=${encodeURIComponent(q)}`);
    meetings = data.meetings || [];
    renderList();
  } catch (err) {
    if (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_INVALID' || err.status === 401) {
      setSession({ token: '', user: null });
      showAuth();
      showError(err.message);
      return;
    }
    meetingList.innerHTML = `<div class="loading">${esc(err.message)}</div>`;
  }
}

function renderList() {
  if (!meetings.length) {
    meetingList.innerHTML = '<div class="loading">No meetings yet. Record one from the extension while logged in.</div>';
    return;
  }
  meetingList.innerHTML = meetings.map((m) => `
    <article class="meeting-item ${m.externalId === activeId ? 'active' : ''}" data-id="${esc(m.externalId)}">
      <h3>${esc(m.title || 'Untitled')}</h3>
      <p>${esc(fmtDate(m.startedAt))} · ${esc(m.platform || 'Manual')}</p>
    </article>
  `).join('');
  meetingList.querySelectorAll('.meeting-item').forEach((el) => {
    el.addEventListener('click', () => openMeeting(el.dataset.id));
  });
}

async function openMeeting(id) {
  activeId = id;
  renderList();
  detailPane.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await api(`/api/meetings/${encodeURIComponent(id)}`);
    const m = data.meeting;
    const ai = m.ai || {};
    detailPane.innerHTML = `
      <div class="detail-hero">
        <div class="kicker">${esc(m.platform || 'Manual')} · MEETING</div>
        <h2>${esc(ai.generatedTitle || m.title || 'Untitled')}</h2>
        <div class="meta">${esc(fmtDate(m.startedAt))} · ${fmtDuration(m.duration)}</div>
      </div>
      <div class="section"><h3>Executive summary</h3><p>${esc(ai.summary || 'No summary yet.')}</p></div>
      <div class="section"><h3>Detailed summary</h3><p>${esc(ai.detailedSummary || ai.summary || '—').replace(/\n/g, '<br>')}</p></div>
      <div class="section"><h3>Key points</h3>${listHtml(ai.keyPoints)}</div>
      <div class="section"><h3>Decisions</h3>${listHtml(ai.decisions)}</div>
      <div class="section"><h3>Action items</h3>${actionHtml(ai.actionItems)}</div>
      <div class="section"><h3>Topics</h3><div class="chips">${(ai.topics || []).map((t) => `<span class="chip"># ${esc(t)}</span>`).join('') || '<span class="chip">None</span>'}</div></div>
      <div class="section"><h3>Risks</h3>${listHtml(ai.risks)}</div>
      <div class="section"><h3>Follow-ups</h3>${listHtml(ai.followUps)}</div>
      <div class="section"><h3>Transcript</h3><p style="white-space:pre-wrap;font-size:13px">${esc(m.fullTranscript || '—')}</p></div>
    `;
  } catch (err) {
    detailPane.innerHTML = `<div class="loading">${esc(err.message)}</div>`;
  }
}

function listHtml(items = []) {
  if (!items?.length) return '<p>None identified.</p>';
  return `<ul>${items.map((x) => `<li>${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</li>`).join('')}</ul>`;
}
function actionHtml(items = []) {
  if (!items?.length) return '<p>None identified.</p>';
  return `<ul>${items.map((a) => `<li><strong>${esc(a.task || '')}</strong>${a.owner ? ` — ${esc(a.owner)}` : ''}${a.deadline ? ` (${esc(a.deadline)})` : ''}</li>`).join('')}</ul>`;
}
function esc(v = '') {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(v) {
  return v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
function fmtDuration(s) {
  const n = Math.max(0, Math.round(Number(s || 0)));
  return `${Math.floor(n / 60)} min`;
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMeetings, 250);
});

async function boot() {
  if (!token) {
    showAuth();
    return;
  }
  try {
    const data = await api('/api/auth/me');
    user = data.user;
    localStorage.setItem('authUser', JSON.stringify(user));
    showApp();
    await loadMeetings();
  } catch {
    setSession({ token: '', user: null });
    showAuth();
  }
}

boot();
