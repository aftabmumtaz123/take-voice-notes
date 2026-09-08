import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerUser,
  loginUser,
  logoutUser,
  requireAuth,
  optionalAuth,
  resolveUser,
  setSessionCookie,
  clearSessionCookie,
  rotateApiKey
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = Number(process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai_note_taker';
const geminiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Try these in order when the preferred model is overloaded / unavailable
const GEMINI_FALLBACKS = [
  geminiModel,
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
].filter((v, i, a) => v && a.indexOf(v) === i);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));


// Loud request logger — every API hit shows in the terminal
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const start = Date.now();
  console.log(`\n>>> ${req.method} ${req.path}  (${new Date().toLocaleTimeString()})`);
  if (req.method !== 'GET' && req.body && Object.keys(req.body).length) {
    const preview = { ...req.body };
    if (preview.fullTranscript) {
      preview.fullTranscript = `[${String(preview.fullTranscript).length} chars]`;
    }
    if (preview.transcript) {
      preview.transcript = `[${Array.isArray(preview.transcript) ? preview.transcript.length : 0} segments]`;
    }
    console.log('    body:', JSON.stringify(preview).slice(0, 300));
  }
  if (req.query && Object.keys(req.query).length) {
    console.log('    query:', JSON.stringify(req.query));
  }
  res.on('finish', () => {
    console.log(`<<< ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)\n`);
  });
  next();
});

const actionItemSchema = new mongoose.Schema({
  task: { type: String, default: '' },
  owner: { type: String, default: '' },
  deadline: { type: String, default: '' },
  completed: { type: Boolean, default: false }
}, { _id: false });

const meetingSchema = new mongoose.Schema({
  externalId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  title: { type: String, default: 'Untitled meeting' },
  platform: { type: String, default: 'Manual' },
  meetingUrl: { type: String, default: '' },
  startedAt: Date,
  endedAt: Date,
  duration: { type: Number, default: 0 },
  participants: [{ name: String, email: String }],
  fullTranscript: { type: String, default: '' },
  transcript: [{ speaker: String, text: String, startTime: Number, endTime: Number, confidence: Number }],
  ai: {
    generatedTitle: { type: String, default: '' },
    summary: { type: String, default: '' },
    detailedSummary: { type: String, default: '' },
    discussionDetails: { type: [{ topic: String, details: String, outcome: String }], default: [] },
    keyPoints: { type: [String], default: [] },
    decisions: { type: [String], default: [] },
    decisionDetails: { type: [{ decision: String, rationale: String }], default: [] },
    actionItems: { type: [actionItemSchema], default: [] },
    topics: { type: [String], default: [] },
    risks: { type: [String], default: [] },
    conflicts: { type: [{ topic: String, perspectives: String, impact: String, resolution: String, status: String }], default: [] },
    openQuestions: { type: [String], default: [] },
    followUps: { type: [String], default: [] },
    generatedAt: Date,
    error: { type: String, default: '' }
  },
  notes: { type: String, default: '' },
  isFavorite: { type: Boolean, default: false },
  isArchived: { type: Boolean, default: false },
  lastSyncError: { type: String, default: '' },
  syncedAt: Date
}, { timestamps: true });

meetingSchema.index({ userId: 1, startedAt: -1 });
meetingSchema.index({ userId: 1, isFavorite: 1, startedAt: -1 });
meetingSchema.index({ userId: 1, isArchived: 1, startedAt: -1 });
meetingSchema.index({ userId: 1, title: 'text', fullTranscript: 'text' });
const Meeting = mongoose.model('Meeting', meetingSchema);

let lastGeminiOkAt = null;
let lastGeminiError = '';

function normalizeMeetingBody(body = {}) {
  return {
    externalId: String(body.externalId || crypto.randomUUID()),
    userId: String(body.userId || 'local-user'),
    title: String(body.title || 'Untitled meeting').slice(0, 160),
    platform: String(body.platform || 'Manual').slice(0, 80),
    meetingUrl: String(body.meetingUrl || '').slice(0, 2000),
    startedAt: body.startedAt ? new Date(body.startedAt) : new Date(),
    endedAt: body.endedAt ? new Date(body.endedAt) : new Date(),
    duration: Math.max(0, Number(body.duration || 0)),
    participants: Array.isArray(body.participants) ? body.participants.slice(0, 100) : [],
    fullTranscript: String(body.fullTranscript || ''),
    transcript: Array.isArray(body.transcript) ? body.transcript : [],
    notes: String(body.notes || '')
  };
}

/** Coerce Gemini values that may be objects into readable strings */
function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (value.text) return String(value.text);
    if (value.title) return String(value.title);
    if (value.description) return String(value.description);
    if (value.item) return String(value.item);
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function emptyAnalysis(reason = '') {
  return {
    generatedTitle: '',
    summary: reason || 'No transcript was captured for this meeting.',
    detailedSummary: '',
    discussionDetails: [],
    keyPoints: [], decisions: [], decisionDetails: [], actionItems: [], topics: [], risks: [],
    conflicts: [], openQuestions: [], followUps: []
  };
}

function isOverloadError(status, message = '') {
  const m = String(message).toLowerCase();
  return status === 429 || status === 503
    || m.includes('high demand')
    || m.includes('resource exhausted')
    || m.includes('unavailable')
    || m.includes('try again later')
    || m.includes('overloaded')
    || m.includes('quota')
    || m.includes('capacity');
}

function logBanner(kind, title, detail = '') {
  const line = '─'.repeat(56);
  if (kind === 'ok') {
    console.log(`\n✅ ${title}`);
    if (detail) console.log(`   ${detail}`);
    console.log(`${line}\n`);
  } else if (kind === 'fail') {
    console.error(`\n❌ ${title}`);
    if (detail) console.error(`   ${detail}`);
    console.error(`${line}\n`);
  } else {
    console.log(`\n⚠️  ${title}`);
    if (detail) console.log(`   ${detail}`);
    console.log(`${line}\n`);
  }
}

async function callGeminiOnce(model, prompt, { json = false, purpose = 'request' } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  console.log(`[gemini] → ${purpose} | model=${model} | promptChars=${prompt.length}`);

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  const started = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError' ? 'Gemini request timed out (90s)' : (err.message || String(err));
    console.error(`[gemini] NETWORK ERROR model=${model}: ${msg}`);
    const e = new Error(msg);
    e.status = 0;
    e.overload = false;
    e.model = model;
    throw e;
  }
  clearTimeout(timeout);

  const elapsed = Date.now() - started;
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const msg = payload?.error?.message
      || payload?.error?.status
      || `Gemini request failed (${response.status})`;
    const full = payload?.error ? JSON.stringify(payload.error) : msg;
    console.error(`[gemini] FAIL status=${response.status} model=${model} ${elapsed}ms`);
    console.error(`[gemini] error body: ${full}`);
    const e = new Error(msg);
    e.status = response.status;
    e.overload = isOverloadError(response.status, msg);
    e.model = model;
    e.raw = payload?.error || null;
    throw e;
  }

  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text.trim()) {
    console.error(`[gemini] EMPTY RESPONSE model=${model} ${elapsed}ms payload=`, JSON.stringify(payload).slice(0, 500));
    const e = new Error('Gemini returned empty content');
    e.status = response.status;
    e.overload = false;
    e.model = model;
    throw e;
  }

  console.log(`[gemini] SUCCESS model=${model} ${elapsed}ms responseChars=${text.length}`);
  return text;
}

async function callGemini(prompt, { json = false, purpose = 'request' } = {}) {
  if (!geminiKey) {
    logBanner('fail', 'GEMINI_API_KEY missing', 'Set GEMINI_API_KEY in server/.env and restart');
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  console.log(`[gemini] start ${purpose} | fallbacks: ${GEMINI_FALLBACKS.join(' → ')}`);

  let lastErr = null;
  for (let i = 0; i < GEMINI_FALLBACKS.length; i++) {
    const model = GEMINI_FALLBACKS[i];
    try {
      const text = await callGeminiOnce(model, prompt, { json, purpose });
      lastGeminiOkAt = new Date();
      lastGeminiError = '';
      logBanner('ok', `${purpose} succeeded`, `model=${model} | chars=${text.length}`);
      return text;
    } catch (err) {
      lastErr = err;
      lastGeminiError = `[${err.model || model}] ${err.message || String(err)}`;
      if (err.overload && i < GEMINI_FALLBACKS.length - 1) {
        logBanner('warn', `Model overloaded: ${model}`, `Trying next: ${GEMINI_FALLBACKS[i + 1]}`);
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      // Non-overload or last model — stop
      break;
    }
  }

  logBanner(
    'fail',
    `${purpose} FAILED`,
    lastErr
      ? `model=${lastErr.model || '?'} | status=${lastErr.status ?? '?'} | ${lastErr.message}`
      : 'Unknown Gemini error'
  );
  throw lastErr || new Error('Gemini request failed');
}

async function analyzeTranscript(meeting) {
  const transcript = String(meeting.fullTranscript || '').trim();
  if (!transcript) {
    console.log('[gemini] skip: empty transcript');
    return emptyAnalysis('No transcript was captured for this meeting.');
  }

  const prompt = `You are a meticulous AI meeting analyst. Analyze ONLY the transcript below. Never invent facts, people, dates, deadlines, decisions, action owners, disagreements, or outcomes. If information is unavailable, use an empty string, empty array, or "Not specified" only when the schema requires a string.

Create a concise meeting-specific title based on the actual subject of the discussion. The title should be 4-8 words, specific and useful in a meeting history list, not generic (avoid titles like "Meeting Notes", "Team Meeting", or "Discussion").

Produce a detailed but faithful summary. Capture the purpose/context, the major discussion threads, important clarifications, requirements, constraints, decisions, and unresolved matters. Do not merely repeat the transcript.

Also identify genuine conflicts/disagreements or competing viewpoints. Only include a conflict when the transcript shows differing opinions, requirements, interpretations, priorities, or unresolved disagreement. Do not label ordinary discussion as conflict.

Return valid JSON with EXACTLY these keys:
generatedTitle, summary, detailedSummary, discussionDetails, keyPoints, decisions, decisionDetails, actionItems, topics, risks, conflicts, openQuestions, followUps.

discussionDetails must be an array of objects: {topic, details, outcome}.
decisionDetails must be an array of objects: {decision, rationale}.
actionItems must be an array of objects: {task, owner, deadline, completed}.
conflicts must be an array of objects: {topic, perspectives, impact, resolution, status}.
openQuestions must contain questions that remain unanswered or require confirmation.

Rules:
- Use only the transcript.
- Do not fabricate participant names.
- Do not invent deadlines or owners.
- Do not infer agreement when none is stated.
- Preserve important numbers, time windows, requirements, and constraints accurately.
- If there is no real conflict, return conflicts as [].
- If there are no open questions, return openQuestions as [].
- Keep the title short and meeting-specific.
- Keep summary around 1-2 strong paragraphs.
- Make detailedSummary substantially richer than summary, around 3-6 paragraphs.
- Keep each discussionDetails.details and outcome concise but informative.

MEETING TITLE CURRENTLY: ${meeting.title}
PLATFORM: ${meeting.platform}

TRANSCRIPT:
${transcript}`;

  // One outer retry on non-overload failures; overload is handled inside callGemini fallbacks
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await callGemini(prompt, { json: true, purpose: 'analyze-transcript' });
      const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Sometimes model still wraps or adds prose — try to extract first {…}
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('Gemini returned non-JSON content');
        parsed = JSON.parse(match[0]);
      }

      return {
        generatedTitle: String(parsed.generatedTitle || '').trim().slice(0, 160),
        summary: String(parsed.summary || ''),
        detailedSummary: String(parsed.detailedSummary || ''),
        discussionDetails: Array.isArray(parsed.discussionDetails) ? parsed.discussionDetails.slice(0, 30).map((x) => ({
          topic: String(x?.topic || ''), details: String(x?.details || ''), outcome: String(x?.outcome || '')
        })) : [],
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(asText).slice(0, 30) : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(asText).slice(0, 30) : [],
        decisionDetails: Array.isArray(parsed.decisionDetails) ? parsed.decisionDetails.slice(0, 30).map((x) => ({
          decision: asText(x?.decision), rationale: asText(x?.rationale)
        })) : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 50).map((x) => ({
          task: asText(x?.task), owner: asText(x?.owner), deadline: asText(x?.deadline), completed: Boolean(x?.completed)
        })) : [],
        topics: Array.isArray(parsed.topics) ? parsed.topics.map(asText).slice(0, 30) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(asText).slice(0, 30) : [],
        conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.slice(0, 30).map((x) => ({
          topic: asText(x?.topic), perspectives: asText(x?.perspectives), impact: asText(x?.impact),
          resolution: asText(x?.resolution), status: asText(x?.status)
        })) : [],
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(asText).slice(0, 30) : [],
        followUps: Array.isArray(parsed.followUps) ? parsed.followUps.map(asText).slice(0, 30) : []
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[gemini] analyze attempt ${attempt} failed:`, err.message);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr || new Error('Gemini analysis failed');
}

async function answerMeetingQuestion(meeting, question) {
  const prompt = `Answer the user's question using ONLY the meeting context below. If the answer is not present, say that it is not available in the transcript. Do not invent facts.

MEETING: ${meeting.title}
SUMMARY: ${meeting.ai?.summary || ''}
TRANSCRIPT:
${meeting.fullTranscript || ''}

QUESTION:
${question}`;
  console.log(`[chat] question="${String(question).slice(0, 120)}" meeting=${meeting.externalId || meeting._id}`);
  return (await callGemini(prompt, { purpose: 'meeting-chat' })).trim() || 'No answer generated.';
}



function buildMeetingExportText(meeting) {
  const ai = meeting.ai || {};
  const lines = [];
  lines.push(ai.generatedTitle || meeting.title || 'Untitled meeting');
  lines.push('='.repeat(48));
  lines.push(`Platform: ${meeting.platform || 'Manual'}`);
  if (meeting.startedAt) lines.push(`Started: ${new Date(meeting.startedAt).toLocaleString()}`);
  if (meeting.duration) lines.push(`Duration: ${Math.round(meeting.duration / 60)} min`);
  lines.push('');
  lines.push('EXECUTIVE SUMMARY');
  lines.push('-'.repeat(48));
  lines.push(ai.summary || 'No summary.');
  lines.push('');
  lines.push('DETAILED SUMMARY');
  lines.push('-'.repeat(48));
  lines.push(ai.detailedSummary || ai.summary || '—');
  lines.push('');
  if (ai.keyPoints?.length) {
    lines.push('KEY POINTS');
    lines.push('-'.repeat(48));
    ai.keyPoints.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push('');
  }
  if (ai.decisions?.length) {
    lines.push('DECISIONS');
    lines.push('-'.repeat(48));
    ai.decisions.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push('');
  }
  if (ai.actionItems?.length) {
    lines.push('ACTION ITEMS');
    lines.push('-'.repeat(48));
    ai.actionItems.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.task || ''}${a.owner ? ` — ${a.owner}` : ''}${a.deadline ? ` (${a.deadline})` : ''}`);
    });
    lines.push('');
  }
  if (ai.topics?.length) {
    lines.push('TOPICS');
    lines.push('-'.repeat(48));
    lines.push(ai.topics.map((t) => `#${t}`).join(', '));
    lines.push('');
  }
  if (ai.openQuestions?.length) {
    lines.push('OPEN QUESTIONS');
    lines.push('-'.repeat(48));
    ai.openQuestions.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push('');
  }
  if (ai.risks?.length) {
    lines.push('RISKS');
    lines.push('-'.repeat(48));
    ai.risks.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push('');
  }
  if (ai.followUps?.length) {
    lines.push('FOLLOW-UPS');
    lines.push('-'.repeat(48));
    ai.followUps.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push('');
  }
  if (meeting.notes) {
    lines.push('NOTES');
    lines.push('-'.repeat(48));
    lines.push(meeting.notes);
    lines.push('');
  }
  lines.push('TRANSCRIPT');
  lines.push('-'.repeat(48));
  lines.push(meeting.fullTranscript || 'No transcript.');
  lines.push('');
  return lines.join('\n');
}

// ─── Web (EJS) ──────────────────────────────────────────────────────
app.get('/', optionalAuth, async (req, res) => {
  if (!req.user) return res.redirect('/login');
  try {
    const q = String(req.query.q || '').trim();
    const view = String(req.query.view || 'all').toLowerCase();
    const filter = { userId: req.user.id };
    if (view === 'favorites') {
      filter.isFavorite = true;
      filter.isArchived = { $ne: true };
    } else if (view === 'archived') {
      filter.isArchived = true;
    } else {
      filter.isArchived = { $ne: true };
    }
    if (q) filter.$text = { $search: q };
    const meetings = await Meeting.find(filter).sort({ startedAt: -1 }).limit(100).lean();
    const success = req.query.success ? String(req.query.success) : null;
    res.render('home', { user: req.user, meetings, q, view, error: null, success });
  } catch (error) {
    res.status(500).render('home', { user: req.user, meetings: [], q: '', view: 'all', error: error.message, success: null });
  }
});

app.get('/login', optionalAuth, (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { user: null, error: null, success: null, formUsername: '' });
});

app.post('/login', async (req, res) => {
  try {
    const result = await loginUser({
      username: req.body.username,
      passkey: req.body.passkey || req.body.password,
      label: 'web'
    });
    setSessionCookie(res, result.token);
    res.redirect('/account?welcome=1');
  } catch (error) {
    res.status(error.status || 400).render('login', {
      user: null,
      error: error.message,
      success: null,
      formUsername: req.body.username || ''
    });
  }
});

app.get('/register', optionalAuth, (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { user: null, error: null, success: null });
});

app.post('/register', async (req, res) => {
  try {
    if (String(req.body.passkey || '') !== String(req.body.passkey2 || '')) {
      return res.status(400).render('register', { user: null, error: 'Passkeys do not match.', success: null });
    }
    const result = await registerUser({
      username: req.body.username,
      passkey: req.body.passkey,
      displayName: req.body.displayName
    });
    setSessionCookie(res, result.token);
    res.redirect('/account?welcome=1');
  } catch (error) {
    res.status(error.status || 400).render('register', { user: null, error: error.message, success: null });
  }
});

app.get('/logout', async (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('note_session='));
  const token = cookie ? decodeURIComponent(cookie.split('=')[1]) : '';
  await logoutUser(token);
  clearSessionCookie(res);
  res.redirect('/login');
});

app.get('/account', requireAuth, (req, res) => {
  const success = req.query.welcome ? 'Account ready. Copy your API key into the Chrome extension.' : null;
  res.render('account', { user: req.user, error: null, success });
});

app.post('/account/rotate-key', requireAuth, async (req, res) => {
  try {
    const user = await rotateApiKey(req.user.id);
    res.render('account', { user, error: null, success: 'API key rotated. Update the extension.' });
  } catch (error) {
    res.status(500).render('account', { user: req.user, error: error.message, success: null });
  }
});


app.get('/meetings/:id/export.txt', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id }).lean();
    if (!meeting) return res.status(404).send('Meeting not found');
    const text = buildMeetingExportText(meeting);
    const safe = String(meeting.title || 'meeting').replace(/[^\w\-]+/g, '_').slice(0, 60);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-summary.txt"`);
    res.send(text);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/meetings/:id/export.md', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id }).lean();
    if (!meeting) return res.status(404).send('Meeting not found');
    const ai = meeting.ai || {};
    const parts = [
      `# ${ai.generatedTitle || meeting.title || 'Untitled meeting'}`,
      '',
      `**Platform:** ${meeting.platform || 'Manual'}  `,
      meeting.startedAt ? `**Started:** ${new Date(meeting.startedAt).toLocaleString()}  ` : '',
      '',
      '## Executive summary',
      '',
      ai.summary || 'No summary.',
      '',
      '## Detailed summary',
      '',
      ai.detailedSummary || ai.summary || '—',
      ''
    ];
    if (ai.keyPoints?.length) {
      parts.push('## Key points', '', ...ai.keyPoints.map((x) => `- ${x}`), '');
    }
    if (ai.decisions?.length) {
      parts.push('## Decisions', '', ...ai.decisions.map((x) => `- ${x}`), '');
    }
    if (ai.actionItems?.length) {
      parts.push('## Action items', '', ...ai.actionItems.map((a) => `- **${a.task || ''}**${a.owner ? ` — ${a.owner}` : ''}${a.deadline ? ` (${a.deadline})` : ''}`), '');
    }
    parts.push('## Transcript', '', '```', meeting.fullTranscript || 'No transcript.', '```', '');
    const safe = String(meeting.title || 'meeting').replace(/[^\w\-]+/g, '_').slice(0, 60);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-summary.md"`);
    res.send(parts.filter((x) => x !== null).join('\n'));
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/meetings/:id/export.pdf', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id }).lean();
    if (!meeting) return res.status(404).send('Meeting not found');
    res.render('export-print', { user: req.user, meeting, autoPrint: true });
  } catch (error) {
    res.status(500).send(error.message);
  }
});


app.get('/meetings/:id', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id }).lean();
    if (!meeting) return res.status(404).send('Meeting not found');
    res.render('meeting', { user: req.user, meeting, error: null, success: null });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/meetings/:id/notes', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndUpdate(
      { externalId: req.params.id, userId: req.user.id },
      { $set: { notes: String(req.body.notes || '') } },
      { returnDocument: 'after' }
    );
    if (!meeting) return res.status(404).send('Meeting not found');
    res.redirect('/meetings/' + req.params.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/meetings/:id/analyze', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id });
    if (!meeting) return res.status(404).send('Meeting not found');
    const generated = await analyzeTranscript(meeting);
    if (generated.generatedTitle) meeting.title = generated.generatedTitle;
    meeting.ai = { ...generated, generatedAt: new Date(), error: '' };
    meeting.lastSyncError = '';
    await meeting.save();
    res.redirect('/meetings/' + req.params.id);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/meetings/:id/favorite', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id });
    if (!meeting) return res.status(404).send('Meeting not found');
    meeting.isFavorite = !meeting.isFavorite;
    await meeting.save();
    const back = req.body.redirect || req.get('Referer') || '/';
    res.redirect(back);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/meetings/:id/archive', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: req.user.id });
    if (!meeting) return res.status(404).send('Meeting not found');
    meeting.isArchived = !meeting.isArchived;
    await meeting.save();
    const back = req.body.redirect || (meeting.isArchived ? '/?view=archived' : '/');
    res.redirect(back);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/meetings/:id/delete', requireAuth, async (req, res) => {
  try {
    await Meeting.deleteOne({ externalId: req.params.id, userId: req.user.id });
    res.redirect('/?success=' + encodeURIComponent('Meeting deleted'));
  } catch (error) {
    res.status(500).send(error.message);
  }
});


app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mongo: mongoose.connection.readyState === 1,
    gemini: Boolean(geminiKey),
    geminiModel,
    geminiFallbacks: GEMINI_FALLBACKS,
    lastGeminiOkAt,
    lastGeminiError: lastGeminiError || null
  });
});

// ─── Auth ───────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const result = await registerUser({
      username: req.body.username,
      passkey: req.body.passkey || req.body.password,
      displayName: req.body.displayName
    });
    console.log(`[auth] registered @${result.username}`);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[auth] register failed:', error.message);
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const label = req.body.label === 'extension' ? 'extension' : 'web';
    const result = await loginUser({
      username: req.body.username,
      passkey: req.body.passkey || req.body.password,
      label
    });
    console.log(`[auth] login @${result.username} (${label})`);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[auth] login failed:', error.message);
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.body?.token || '');
    await logoutUser(token);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.post('/api/auth/rotate-key', requireAuth, async (req, res) => {
  try {
    const user = await rotateApiKey(req.user.id);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

/** Quick manual test: curl -X POST http://localhost:4000/api/test-gemini */
app.post('/api/test-gemini', async (_req, res) => {
  console.log('\n>>> MANUAL Gemini test starting…');
  try {
    const text = await callGemini(
      'Reply with exactly this JSON: {"ok":true,"message":"gemini works"}',
      { json: true, purpose: 'manual-test' }
    );
    res.json({ ok: true, response: text.slice(0, 500) });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      status: error.status,
      model: error.model,
      lastGeminiError
    });
  }
});

app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const q = String(req.query.q || '').trim();
    const view = String(req.query.view || 'all').toLowerCase();
    const filter = { userId };
    if (view === 'favorites') {
      filter.isFavorite = true;
      filter.isArchived = { $ne: true };
    } else if (view === 'archived') {
      filter.isArchived = true;
    } else if (view !== 'all') {
      filter.isArchived = { $ne: true };
    } else {
      // default list hides archived unless explicitly requested
      filter.isArchived = { $ne: true };
    }
    if (q) filter.$text = { $search: q };
    const meetings = await Meeting.find(filter).sort({ startedAt: -1 }).limit(100).lean();
    res.json({ ok: true, meetings, user: req.user });
  } catch (error) {
    console.error('[api] list meetings:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/meetings/:id', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({
      externalId: req.params.id,
      userId: req.user.id
    }).lean();
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    res.json({ ok: true, meeting });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/meetings/complete', requireAuth, async (req, res) => {
  try {
    const data = normalizeMeetingBody({ ...req.body, userId: req.user.id });
    console.log(`[api] complete user=@${req.user.username} externalId=${data.externalId} transcriptChars=${data.fullTranscript.length}`);

    const meeting = await Meeting.findOneAndUpdate(
      { externalId: data.externalId, userId: data.userId },
      {
        $set: {
          ...data,
          lastSyncError: '',
          syncedAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    let analysis = meeting.ai || {};
    let analysisReady = false;
    try {
      const generated = await analyzeTranscript(meeting);
      analysis = { ...generated, generatedAt: new Date(), error: '' };
      if (generated.generatedTitle) meeting.title = generated.generatedTitle;
      meeting.ai = analysis;
      await meeting.save();
      analysisReady = Boolean(analysis.summary) && !analysis.error;
      logBanner('ok', 'Meeting saved + analyzed', `title="${meeting.title}" | analysisReady=${analysisReady}`);
    } catch (error) {
      logBanner('fail', 'Meeting saved but analysis FAILED', error.message);
      meeting.ai = { ...(meeting.ai || {}), error: error.message, generatedAt: null };
      meeting.lastSyncError = error.message;
      await meeting.save();
      analysis = meeting.ai;
    }

    res.json({
      ok: true,
      meeting: meeting.toObject(),
      analysisReady,
      analysisError: analysis?.error || ''
    });
  } catch (error) {
    console.error('[api] complete failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/meetings/:id/analyze', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({
      externalId: req.params.id,
      userId: req.user.id
    });
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });

    console.log(`[api] re-analyze requested for ${req.params.id}`);
    const generated = await analyzeTranscript(meeting);
    if (generated.generatedTitle) meeting.title = generated.generatedTitle;
    meeting.ai = { ...generated, generatedAt: new Date(), error: '' };
    meeting.lastSyncError = '';
    await meeting.save();
    logBanner('ok', 'Re-analyze complete', `title="${meeting.title}"`);
    res.json({ ok: true, meeting: meeting.toObject() });
  } catch (error) {
    logBanner('fail', 'Re-analyze FAILED', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/meetings/:id/chat', requireAuth, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({
      externalId: req.params.id,
      userId: req.user.id
    }).lean();
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ ok: false, error: 'Question is required.' });
    const answer = await answerMeetingQuestion(meeting, question);
    console.log(`[api] chat OK meeting=${req.params.id}`);
    res.json({ ok: true, answer });
  } catch (error) {
    console.error(`[api] chat FAIL meeting=${req.params.id}:`, error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/meetings/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const allowed = {};
    for (const key of ['title', 'notes']) if (req.body[key] !== undefined) allowed[key] = String(req.body[key]);
    if (req.body.ai) allowed.ai = req.body.ai;
    if (req.body.isFavorite !== undefined) allowed.isFavorite = Boolean(req.body.isFavorite);
    if (req.body.isArchived !== undefined) allowed.isArchived = Boolean(req.body.isArchived);
    if (!Object.keys(allowed).length) {
      return res.status(400).json({ ok: false, error: 'No valid fields to update.' });
    }
    const meeting = await Meeting.findOneAndUpdate(
      { externalId: req.params.id, userId },
      { $set: allowed },
      { returnDocument: 'after' }
    ).lean();
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    res.json({ ok: true, meeting });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/meetings/:id', requireAuth, async (req, res) => {
  try {
    const result = await Meeting.deleteOne({
      externalId: req.params.id,
      userId: req.user.id
    });
    res.json({ ok: true, deleted: result.deletedCount > 0 });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

mongoose.connect(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`AI Note Taker API listening on http://localhost:${port}`);
      console.log(`Mongo: connected | Gemini key: ${geminiKey ? 'set' : 'MISSING'}`);
      console.log(`Gemini models (in order): ${GEMINI_FALLBACKS.join(' → ')}`);
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
