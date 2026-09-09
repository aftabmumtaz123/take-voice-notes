import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  registerUser,
  loginUser,
  logoutUser,
  requireAuth,
  requireAdmin,
  optionalAuth,
  resolveUser,
  setSessionCookie,
  clearSessionCookie,
  rotateApiKey,
  postLoginRedirect,
  seedDefaults,
  User,
  Plan,
  publicUser,
  getSiteSettings,
  updateSiteSettings,
  completeOnboarding,
  isPaidPlan,
  planBadgeLabel,
  isUnlimited,
  formatLimit,
  findOrCreateGoogleUser
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = Number(process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai_note_taker';
const geminiKey = process.env.GEMINI_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/google/callback`;
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly'
].join(' ');
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
  participants: [{
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    talkSeconds: { type: Number, default: 0 },
    talkPercent: { type: Number, default: 0 },
    color: { type: String, default: '' }
  }],
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

// Short-lived lifecycle state used by the post-meeting processing screen.
// It is intentionally separate from the Meeting document so the UI can show
// progress while /api/meetings/complete is still saving/analyzing.
const meetingProcessingStates = new Map();
const meetingProcessingLocks = new Map();

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
    participants: Array.isArray(body.participants)
      ? body.participants.slice(0, 100).map((p) => ({
          name: String(p?.name || p?.displayName || '').slice(0, 120),
          email: String(p?.email || '').slice(0, 200),
          talkSeconds: Math.max(0, Number(p?.talkSeconds || p?.talkTime || 0)),
          talkPercent: Math.max(0, Math.min(100, Number(p?.talkPercent || 0))),
          color: String(p?.color || '').slice(0, 20)
        }))
      : [],
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

Create a concise meeting-specific title based on the actual subject of the discussion. The title should be 4-10 words, specific and useful in a meeting history list, not generic (avoid titles like "Meeting Notes", "Team Meeting", or "Discussion").

Write TWO levels of narrative summary:

1) summary — an executive overview of 2–4 full paragraphs. Cover meeting purpose/context, who/what was involved when stated, the main topics, the most important outcomes, and any critical open issues. This should still be readable as a standalone briefing.

2) detailedSummary — a thorough meeting narrative of 6–12 substantial paragraphs (or clearly separated sections). Walk through the discussion in logical order:
   - Opening context and goals
   - Each major topic thread: what was said, options considered, constraints, numbers/dates/requirements mentioned
   - Clarifications and important side points
   - Decisions reached and why
   - Action items and ownership when stated
   - Unresolved questions, risks, and next steps
   Do NOT merely list bullets here — write connected prose that someone who missed the meeting can use as a full substitute for reading the transcript. Preserve concrete details (names only if spoken, amounts, deadlines, product/feature names, URLs, metrics).

Also identify genuine conflicts/disagreements or competing viewpoints. Only include a conflict when the transcript shows differing opinions, requirements, interpretations, priorities, or unresolved disagreement. Do not label ordinary discussion as conflict.

Return valid JSON with EXACTLY these keys:
generatedTitle, summary, detailedSummary, discussionDetails, keyPoints, decisions, decisionDetails, actionItems, topics, risks, conflicts, openQuestions, followUps.

Field guidance:
- discussionDetails: array of {topic, details, outcome}. Aim for one entry per major discussion thread. "details" should be 2–5 sentences capturing what was explored; "outcome" is the result or "Still open" if unresolved.
- decisionDetails: array of {decision, rationale}. Prefer these over short one-liners when a decision has context.
- decisions: short string list of the same decisions for quick scanning.
- actionItems: array of {task, owner, deadline, completed}. owner/deadline only if explicitly stated; otherwise "".
- keyPoints: 5–12 high-signal bullets of facts, requirements, or takeaways.
- topics: short topic tags.
- risks: blockers, dependencies, or risks mentioned.
- conflicts: array of {topic, perspectives, impact, resolution, status}.
- openQuestions: questions that remain unanswered or need confirmation.
- followUps: concrete next-step items even if not formal action items.

Rules:
- Use only the transcript.
- Do not fabricate participant names.
- Do not invent deadlines or owners.
- Do not infer agreement when none is stated.
- Preserve important numbers, time windows, requirements, and constraints accurately.
- If there is no real conflict, return conflicts as [].
- If there are no open questions, return openQuestions as [].
- Keep the title short and meeting-specific.
- Prefer completeness over brevity for detailedSummary and discussionDetails.
- detailedSummary MUST be substantially longer and more specific than summary.

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

const MEETING_PROMPT_TEMPLATES = {
  detailed_transcript: {
    id: 'detailed_transcript',
    label: 'Detailed transcription',
    icon: 'description',
    instruction: `Create a detailed, chronological reconstruction of the meeting from the transcript. Preserve only what was actually said. Use speaker names only when present in the transcript or participant metadata. Include timestamps when available. Do not invent missing speech.`
  },
  short_summary: {
    id: 'short_summary',
    label: 'Short summary',
    icon: '✦',
    instruction: `Write a SHORT executive summary of this meeting in 1–2 tight paragraphs (or 5–7 bullets if clearer).
Focus only on: purpose, main outcomes, and the most important next step.
Do not include long discussion detail.`
  },
  detailed_summary: {
    id: 'detailed_summary',
    label: 'Detailed summary',
    icon: '✦',
    instruction: `Write a DETAILED meeting summary in Markdown.
Use sections:
## Overview
## Discussion
## Decisions
## Action items
## Open questions / next steps
Walk through the conversation in order. Preserve concrete numbers, names (only if spoken), deadlines, and requirements. Aim for 6–12 substantial paragraphs or equivalent structured sections.`
  },
  detailed_with_citations: {
    id: 'detailed_with_citations',
    label: 'Detailed summary with citation',
    icon: '✦',
    instruction: `Write a detailed summary with light citations back to the transcript.
For important claims, add a short quote or paraphrase in italics after the point, e.g. _(“…quote…”)_ .
Structure with ## headings. Include Overview, Key discussion points, Decisions, and Next steps.`
  },
  summary_and_actions: {
    id: 'summary_and_actions',
    label: 'Summary and Action items',
    icon: '📋',
    instruction: `Produce:
## Summary
2–4 paragraphs covering purpose and outcomes.
## Action items
A checkbox list: - [ ] Task (Owner: Name if known; Deadline: if known)
Only include real action items from the transcript. If none, say so under the heading.`
  },
  team_sync: {
    id: 'team_sync',
    label: 'Team Sync – Project Updates',
    icon: '👥',
    instruction: `Format as a team sync update in Markdown:
## Project status
## What was discussed
## Blockers / risks
## Decisions
## Action items
- [ ] Task (Owner)
Keep it scannable for someone who missed the meeting.`
  },
  smart_advice: {
    id: 'smart_advice',
    label: 'Smart AI Advice',
    icon: '💡',
    instruction: `Based only on this meeting, give practical advice:
## What went well
## Risks or gaps
## Recommended next moves
## Questions the team should resolve
Be concrete and grounded in the transcript. Do not invent external facts.`
  },
  task_list: {
    id: 'task_list',
    label: 'Short task list',
    icon: 'checklist',
    instruction: `Create a short, prioritized task list from the meeting. Use checkbox bullets only. Include an owner and deadline only when explicitly supported by the transcript.`
  },
  other_mentions: {
    id: 'other_mentions',
    label: 'Other mentions',
    icon: 'alternate_email',
    instruction: `Extract notable mentions that are not already clear decisions or action items: people mentioned, products, customers, dates, requirements, risks, questions, or references. Group them under concise headings. Do not invent context.`
  },
  generate_tasks: {
    id: 'generate_tasks',
    label: 'Generate tasks',
    icon: '☑',
    instruction: `Extract a clean task list from the meeting.
Use only checkbox items:
- [ ] Task description — Owner: … — Deadline: … (omit owner/deadline if unknown)
Group under ## Tasks if helpful. No fluff — tasks only, or a short note if none exist.`
  },
  prepare_slides: {
    id: 'prepare_slides',
    label: 'Prepare slides',
    icon: '▶',
    instruction: `Turn this meeting into a slide outline in Markdown.
Use ## Slide 1: Title, ## Slide 2: … etc.
Each slide: 3–6 short bullets max. Cover: title/context, key points, decisions, action items, next steps.
Suitable for a 5–8 slide recap deck.`
  },
  key_decisions: {
    id: 'key_decisions',
    label: 'Key decisions',
    icon: '🔵',
    instruction: `List only the decisions made in this meeting.
Format each as:
🔵 **Decision** — brief rationale if stated
If none, say no explicit decisions were recorded.`
  },
  next_steps: {
    id: 'next_steps',
    label: 'Next steps',
    icon: '→',
    instruction: `List concrete next steps and follow-ups from the meeting as:
- [ ] Step (Owner if known)
Include open questions that block progress under ## Open questions.`
  }
};

async function answerMeetingQuestion(meeting, question, promptId = null) {
  const template = promptId ? MEETING_PROMPT_TEMPLATES[promptId] : null;
  const taskBlock = template
    ? `PROMPT TEMPLATE: ${template.label}\n\nYOUR TASK:\n${template.instruction}`
    : `QUESTION:\n${question}`;

  const prompt = `You are a meeting assistant. Use ONLY the meeting context below.
If information is not present in the transcript or summary, say so clearly. Do not invent facts, names, deadlines, or owners.

Format your answer as clean Markdown for a product UI:
- Use ## / ### headings when helpful.
- Use **bold** for key terms.
- Use bullet lists for key points.
- For tasks/action items use: - [ ] Task (Owner: Name) when applicable.
- For decisions you may use: 🔵 **Topic** — decision text
- Never wrap the entire answer in a code fence.
- Do not invent content beyond the meeting context.

MEETING: ${meeting.title}
SUMMARY: ${meeting.ai?.summary || ''}
DETAILED SUMMARY: ${meeting.ai?.detailedSummary || ''}
KEY POINTS: ${(meeting.ai?.keyPoints || []).join(' | ')}
DECISIONS: ${(meeting.ai?.decisions || []).join(' | ')}
ACTION ITEMS: ${JSON.stringify(meeting.ai?.actionItems || [])}
TRANSCRIPT:
${meeting.fullTranscript || ''}

${taskBlock}`;

  const label = template ? template.id : String(question).slice(0, 120);
  console.log(`[chat] prompt="${label}" meeting=${meeting.externalId || meeting._id}`);
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
  // Logged-in users go to their app / admin; guests see the marketing landing page
  if (req.user) return res.redirect(postLoginRedirect(req.user));
  const [plans, settings] = await Promise.all([
    Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean().catch(() => []),
    getSiteSettings().catch(() => null)
  ]);
  res.render('landing', { user: null, plans, settings, error: null, success: null });
});


async function loadUserPlanContext(user) {
  const plan = await Plan.findOne({ slug: user.planSlug || 'free' }).lean().catch(() => null);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const usedThisMonth = await Meeting.countDocuments({
    userId: user.id,
    createdAt: { $gte: monthStart }
  }).catch(() => 0);
  const aiThisMonth = await Meeting.countDocuments({
    userId: user.id,
    createdAt: { $gte: monthStart },
    'ai.summary': { $exists: true, $ne: '' }
  }).catch(() => 0);
  const durationSec = await Meeting.aggregate([
    { $match: { userId: user.id, createdAt: { $gte: monthStart } } },
    { $group: { _id: null, total: { $sum: '$duration' } } }
  ]).then((r) => r[0]?.total || 0).catch(() => 0);
  const maxMeetings = plan?.maxMeetingsPerMonth ?? 5;
  const remainingPct = isUnlimited(maxMeetings)
    ? 100
    : Math.max(0, Math.round((1 - usedThisMonth / Math.max(1, maxMeetings)) * 100));
  return {
    plan,
    usage: {
      meetingsUsed: usedThisMonth,
      meetingsMax: maxMeetings,
      aiNotes: aiThisMonth,
      transcriptionMinutes: Math.round(durationSec / 60),
      remainingPct,
      isPaid: isPaidPlan(user.planSlug),
      badge: planBadgeLabel(user.planSlug)
    }
  };
}


app.get('/app', requireAuth, (req, res) => res.redirect('/app/overview'));

app.get('/app/overview', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      // admins can still view user overview
    }
    const settings = await getSiteSettings().catch(() => null);
    const ctx = await loadUserPlanContext(req.user);
    const recent = await Meeting.find({ userId: req.user.id, isArchived: { $ne: true } })
      .sort({ startedAt: -1 }).limit(5).lean();
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    res.render('overview', {
      user: req.user,
      settings,
      plan: ctx.plan,
      usage: ctx.usage,
      recent,
      greet,
      error: null,
      success: null
    });
  } catch (error) {
    res.status(500).render('overview', {
      user: req.user, settings: null, plan: null,
      usage: { meetingsUsed: 0, meetingsMax: 5, aiNotes: 0, remainingPct: 100, isPaid: false, badge: 'FREE' },
      recent: [], greet: 'Hello', error: error.message, success: null
    });
  }
});

app.get('/app/meetings', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const view = String(req.query.view || 'all');
    const filter = { userId: req.user.id };
    if (view === 'favorites') filter.isFavorite = true;
    else if (view === 'archived') filter.isArchived = true;
    else filter.isArchived = { $ne: true };
    if (q) {
      filter.$or = [
        { title: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { platform: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }
    const meetings = await Meeting.find(filter).sort({ startedAt: -1 }).limit(100).lean();
    const success = req.query.success ? String(req.query.success) : null;
    const settings = await getSiteSettings().catch(() => null);
    const ctx = await loadUserPlanContext(req.user);
    res.render('home', {
      user: req.user, meetings, q, view, error: null, success, settings,
      plan: ctx.plan, usage: ctx.usage
    });
  } catch (error) {
    res.status(500).render('home', {
      user: req.user, meetings: [], q: '', view: 'all', error: error.message, success: null,
      settings: null, plan: null, usage: { meetingsUsed: 0, meetingsMax: 5, remainingPct: 100, isPaid: false, badge: 'FREE' }
    });
  }
});

app.get('/app/insights', requireAuth, async (req, res) => {
  const settings = await getSiteSettings().catch(() => null);
  const ctx = await loadUserPlanContext(req.user);
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0,0,0,0);
  const meetings = await Meeting.find({
    userId: req.user.id,
    startedAt: { $gte: weekStart }
  }).lean().catch(() => []);
  const totalMin = Math.round(meetings.reduce((s, m) => s + (m.duration || 0), 0) / 60);
  let actionItems = 0;
  const topics = {};
  for (const m of meetings) {
    const items = m.ai?.actionItems || [];
    actionItems += items.length;
    const title = (m.title || 'Other').split(' ').slice(0, 3).join(' ');
    topics[title] = (topics[title] || 0) + 1;
  }
  const topicList = Object.entries(topics).sort((a,b) => b[1]-a[1]).slice(0, 6);
  res.render('insights', {
    user: req.user, settings, plan: ctx.plan, usage: ctx.usage,
    insights: {
      meetings: meetings.length,
      totalMin,
      actionItems,
      decisions: Math.round(actionItems * 0.6),
      topics: topicList,
      isPaid: ctx.usage.isPaid
    },
    error: null, success: null
  });
});

app.get('/app/usage', requireAuth, async (req, res) => {
  const settings = await getSiteSettings().catch(() => null);
  const ctx = await loadUserPlanContext(req.user);
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysLeft = Math.max(1, Math.ceil((end - now) / 86400000));
  const [recentUsage, plans] = await Promise.all([
    Meeting.find({ userId: req.user.id, createdAt: { $gte: monthStart } })
      .sort({ createdAt: -1 }).limit(10)
      .select('title startedAt createdAt duration ai.summary ai.actionItems')
      .lean().catch(() => []),
    Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean().catch(() => [])
  ]);
  const usageHistory = recentUsage.map((m) => ({
    title: m.title || 'Untitled meeting',
    date: m.startedAt || m.createdAt,
    minutes: Math.round((m.duration || 0) / 60),
    summary: Boolean(m.ai?.summary),
    actionItems: Array.isArray(m.ai?.actionItems) ? m.ai.actionItems.length : 0
  }));
  res.render('usage', {
    user: req.user, settings, plan: ctx.plan, usage: ctx.usage, daysLeft,
    usageHistory, plans, error: null, success: null
  });
});


app.get('/login', optionalAuth, async (req, res) => {
  if (req.user) return res.redirect(postLoginRedirect(req.user));
  const settings = await getSiteSettings().catch(() => null);
  res.render('login', {
    user: null,
    error: req.query.error || null,
    success: null,
    formUsername: '',
    settings,
    googleEnabled: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  });
});

app.post('/login', async (req, res) => {
  try {
    const result = await loginUser({
      username: req.body.username,
      passkey: req.body.passkey || req.body.password,
      label: 'web'
    });
    setSessionCookie(res, result.token);
    res.redirect(postLoginRedirect(result.user));
  } catch (error) {
    const settings = await getSiteSettings().catch(() => null);
    res.status(error.status || 400).render('login', {
      user: null,
      error: error.message,
      success: null,
      formUsername: req.body.username || '',
      settings,
      googleEnabled: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
    });
  }
});

// ─── Google OAuth ────────────────────────────────────────────────────────────
app.get('/api/google/start', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not configured.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader(
    'Set-Cookie',
    `google_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
  );
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

function parseCookieHeader(header = '') {
  const out = {};
  String(header || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i === -1) return;
      out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
    });
  return out;
}

app.get('/api/google/callback', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not configured.'));
    }
    const { code, state, error } = req.query;
    if (error) {
      return res.redirect('/login?error=' + encodeURIComponent(String(error)));
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    const expected = cookies.google_oauth_state;
    if (!code || !state || !expected || state !== expected) {
      return res.redirect('/login?error=' + encodeURIComponent('Invalid OAuth state. Try again.'));
    }
    res.setHeader('Set-Cookie', 'google_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[google] token exchange failed', tokenData);
      return res.redirect('/login?error=' + encodeURIComponent(tokenData.error_description || 'Google token exchange failed.'));
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok || !profile.sub) {
      return res.redirect('/login?error=' + encodeURIComponent('Could not load Google profile.'));
    }

    const result = await findOrCreateGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      displayName: profile.name || profile.email,
      avatarUrl: profile.picture,
      tokens: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || '',
        expiryDate: Date.now() + (Number(tokenData.expires_in) || 3600) * 1000,
        scope: tokenData.scope || GOOGLE_SCOPES
      }
    });
    setSessionCookie(res, result.token);
    console.log(`[auth] google login @${result.user.username}`);
    res.redirect(postLoginRedirect(result.user));
  } catch (err) {
    console.error('[google] callback error', err.message);
    res.redirect('/login?error=' + encodeURIComponent(err.message || 'Google sign-in failed.'));
  }
});

app.get('/register', optionalAuth, async (req, res) => {
  if (req.user) return res.redirect(postLoginRedirect(req.user));
  const settings = await getSiteSettings().catch(() => null);
  res.render('register', { user: null, error: null, success: null, settings });
});

app.post('/register', async (req, res) => {
  try {
    if (String(req.body.passkey || '') !== String(req.body.passkey2 || '')) {
      const settings = await getSiteSettings().catch(() => null);
      return res.status(400).render('register', { user: null, error: 'Passkeys do not match.', success: null, settings });
    }
    const result = await registerUser({
      username: req.body.username,
      passkey: req.body.passkey,
      displayName: req.body.displayName
    });
    setSessionCookie(res, result.token);
    res.redirect(postLoginRedirect(result.user));
  } catch (error) {
    const settings = await getSiteSettings().catch(() => null);
    res.status(error.status || 400).render('register', { user: null, error: error.message, success: null, settings });
  }
});

app.get('/logout', async (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('note_session='));
  const token = cookie ? decodeURIComponent(cookie.split('=')[1]) : '';
  await logoutUser(token);
  clearSessionCookie(res);
  res.redirect('/');
});

app.get('/onboarding', requireAuth, async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin');
  if (req.user.onboardingCompleted) return res.redirect('/app');
  const settings = await getSiteSettings().catch(() => null);
  res.render('onboarding', {
    user: req.user,
    settings,
    step: Number(req.query.step || 1),
    error: null
  });
});

app.post('/onboarding', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.redirect('/admin');
    const step = Number(req.body.step || 1);
    const settings = await getSiteSettings().catch(() => null);

    if (step === 1) {
      const useCase = String(req.body.useCase || '').trim();
      if (!useCase) {
        return res.status(400).render('onboarding', {
          user: req.user, settings, step: 1, error: 'Please choose an option.'
        });
      }
      // stash in session via query for step 2 — persist partial on user
      await User.findByIdAndUpdate(req.user.id, {
        $set: { 'onboarding.useCase': useCase.slice(0, 80) }
      });
      return res.redirect('/onboarding?step=2');
    }

    if (step === 2) {
      const heardFrom = String(req.body.heardFrom || '').trim();
      if (!heardFrom) {
        return res.status(400).render('onboarding', {
          user: req.user, settings, step: 2, error: 'Please choose an option.'
        });
      }
      const existing = await User.findById(req.user.id).lean();
      const useCase = existing?.onboarding?.useCase || '';
      await completeOnboarding(req.user.id, { useCase, heardFrom });
      return res.redirect('/onboarding?step=3');
    }

    // step 3 continue
    return res.redirect('/app/overview');
  } catch (error) {
    const settings = await getSiteSettings().catch(() => null);
    res.status(500).render('onboarding', {
      user: req.user, settings, step: 1, error: error.message
    });
  }
});

app.get('/install', optionalAuth, async (req, res) => {
  const settings = await getSiteSettings().catch(() => null);
  res.render('install', { user: req.user || null, settings });
});

app.post('/onboarding/skip', requireAuth, async (req, res) => {
  try {
    await completeOnboarding(req.user.id, {
      useCase: 'skipped',
      heardFrom: 'skipped'
    });
  } catch (_) {}
  res.redirect('/app/overview');
});


// ─── Admin ──────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const prevMonthStart = new Date(monthStart);
  prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);

  const [
    userCount,
    usersThisMonth,
    usersPrevMonth,
    meetingCount,
    meetingsThisMonth,
    meetingsPrevMonth,
    planCount,
    recentUsers,
    plans,
    activeUsers,
    meetingsWithAi,
    totalDurationSec
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: monthStart } }),
    User.countDocuments({ createdAt: { $gte: prevMonthStart, $lt: monthStart } }),
    Meeting.countDocuments(),
    Meeting.countDocuments({ createdAt: { $gte: monthStart } }),
    Meeting.countDocuments({ createdAt: { $gte: prevMonthStart, $lt: monthStart } }),
    Plan.countDocuments({ isActive: true }),
    User.find().sort({ createdAt: -1 }).limit(8).lean(),
    Plan.find().sort({ sortOrder: 1 }).lean(),
    User.countDocuments({ isActive: { $ne: false } }),
    Meeting.countDocuments({ 'ai.summary': { $exists: true, $ne: '' } }),
    Meeting.aggregate([{ $group: { _id: null, total: { $sum: '$duration' } } }]).then((r) => r[0]?.total || 0).catch(() => 0)
  ]);

  const planDist = {};
  for (const pl of plans) planDist[pl.slug] = 0;
  const byPlan = await User.aggregate([
    { $group: { _id: '$planSlug', count: { $sum: 1 } } }
  ]).catch(() => []);
  for (const row of byPlan) {
    const key = row._id || 'free';
    planDist[key] = row.count;
  }

  const paidSubs = await User.countDocuments({
    planSlug: { $nin: ['free', null, ''] },
    isActive: { $ne: false }
  }).catch(() => 0);

  // per-user meeting counts for recent table
  const recentIds = recentUsers.map((u) => u._id);
  const meetingCounts = await Meeting.aggregate([
    { $match: { userId: { $in: recentIds.map(String) } } },
    { $group: { _id: '$userId', total: { $sum: 1 }, withAi: { $sum: { $cond: [{ $and: [{ $ifNull: ['$ai.summary', false] }, { $ne: ['$ai.summary', ''] }] }, 1, 0] } } } }
  ]).catch(() => []);
  const countMap = Object.fromEntries(meetingCounts.map((m) => [String(m._id), m]));

  const pct = (cur, prev) => {
    if (!prev) return cur ? 100 : 0;
    return Math.round(((cur - prev) / prev) * 1000) / 10;
  };

  const transcriptionMinutes = Math.round(Number(totalDurationSec || 0) / 60);
  // rough token estimate for display
  const aiTokensEstimate = Math.round((meetingsWithAi || 0) * 2400);

  const recentActivity = [];
  for (const u of recentUsers.slice(0, 5)) {
    recentActivity.push({
      text: `@${u.username} joined the platform`,
      time: u.createdAt,
      type: 'user'
    });
  }
  const recentMeetings = await Meeting.find().sort({ createdAt: -1 }).limit(5).lean().catch(() => []);
  for (const m of recentMeetings) {
    recentActivity.push({
      text: m.ai?.summary
        ? `AI summary generated · ${m.title || 'Meeting'}`
        : `Meeting processed · ${m.title || 'Untitled'}`,
      time: m.createdAt || m.startedAt,
      type: m.ai?.summary ? 'ai' : 'meeting'
    });
  }
  recentActivity.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

  // simple sparkline series from last 7 days of meetings
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    d0.setDate(d0.getDate() - i);
    const d1 = new Date(d0);
    d1.setDate(d1.getDate() + 1);
    const c = await Meeting.countDocuments({ createdAt: { $gte: d0, $lt: d1 } }).catch(() => 0);
    series.push({ label: d0.toLocaleDateString([], { weekday: 'short' }), value: c });
  }

  const mongoOk = mongoose.connection.readyState === 1;
  const geminiOk = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  res.render('admin/dashboard', {
    user: req.user,
    stats: {
      userCount,
      usersThisMonth,
      usersGrowth: pct(usersThisMonth, usersPrevMonth),
      activeSubscriptions: paidSubs,
      meetingCount,
      meetingsThisMonth,
      meetingsGrowth: pct(meetingsThisMonth, meetingsPrevMonth),
      aiNotesCount: meetingsWithAi,
      transcriptionMinutes,
      aiTokensEstimate,
      extensionActiveUsers: activeUsers,
      planCount,
      monthlyRevenueEstimate: paidSubs * 12 // illustrative
    },
    planDist,
    plans,
    series,
    recentActivity: recentActivity.slice(0, 8),
    recentUsers: recentUsers.map((u) => {
      const c = countMap[String(u._id)] || { total: 0, withAi: 0 };
      return {
        ...publicUser(u),
        meetingsCount: c.total || 0,
        aiNotesCount: c.withAi || 0
      };
    }),
    health: {
      api: true,
      ai: geminiOk,
      transcription: true,
      database: mongoOk,
      extension: true
    },
    error: null,
    success: req.query.success || null
  });
});

async function buildUserStatsMap(userIds) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const ids = userIds.map(String);
  const [meetingCounts, aiCounts] = await Promise.all([
    Meeting.aggregate([
      { $match: { userId: { $in: ids }, createdAt: { $gte: monthStart } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } }
    ]),
    Meeting.aggregate([
      {
        $match: {
          userId: { $in: ids },
          createdAt: { $gte: monthStart },
          'ai.summary': { $exists: true, $ne: '' }
        }
      },
      { $group: { _id: '$userId', count: { $sum: 1 } } }
    ])
  ]);
  const meetingsMap = Object.fromEntries(meetingCounts.map((r) => [r._id, r.count]));
  const aiMap = Object.fromEntries(aiCounts.map((r) => [r._id, r.count]));
  return { meetingsMap, aiMap, monthStart };
}

app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const planFilter = String(req.query.plan || 'all');
    const roleFilter = String(req.query.role || 'all');
    const statusFilter = String(req.query.status || 'all');
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 20;

    const filter = {};
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ username: rx }, { displayName: rx }];
    }
    if (planFilter !== 'all') filter.planSlug = planFilter;
    if (roleFilter !== 'all') filter.role = roleFilter;
    if (statusFilter === 'active') filter.isActive = { $ne: false };
    if (statusFilter === 'disabled') filter.isActive = false;

    const [total, usersRaw, plans, totalAll, activeAll, proAll, freeAll] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Plan.find().sort({ sortOrder: 1 }).lean(),
      User.countDocuments(),
      User.countDocuments({ isActive: { $ne: false } }),
      User.countDocuments({ planSlug: { $nin: ['free', null, ''] }, isActive: { $ne: false } }),
      User.countDocuments({ $or: [{ planSlug: 'free' }, { planSlug: null }, { planSlug: '' }] })
    ]);

    const planBySlug = Object.fromEntries(plans.map((p) => [p.slug, p]));
    const { meetingsMap, aiMap } = await buildUserStatsMap(usersRaw.map((u) => u._id));

    const users = usersRaw.map((u) => {
      const pub = publicUser(u);
      const meetings = meetingsMap[pub.id] || 0;
      const aiNotes = aiMap[pub.id] || 0;
      const maxM = planBySlug[pub.planSlug]?.maxMeetingsPerMonth;
      const usagePct = isUnlimited(maxM) ? null : Math.min(100, Math.round((meetings / Math.max(1, maxM ?? 5)) * 100));
      return {
        ...pub,
        _id: u._id.toString(),
        stats: { meetings, aiNotes, usagePct }
      };
    });

    res.render('admin/users', {
      user: req.user,
      users,
      plans,
      stats: { total: totalAll, active: activeAll, pro: proAll, free: freeAll },
      filters: { q, plan: planFilter, role: roleFilter, status: statusFilter },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.status(500).render('admin/users', {
      user: req.user,
      users: [],
      plans: [],
      stats: { total: 0, active: 0, pro: 0, free: 0 },
      filters: { q: '', plan: 'all', role: 'all', status: 'all' },
      pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
      error: error.message,
      success: null
    });
  }
});

app.get('/admin/users/new', requireAdmin, async (req, res) => {
  const plans = await Plan.find().sort({ sortOrder: 1 }).lean();
  res.render('admin/user-new', {
    user: req.user,
    plans,
    form: null,
    error: req.query.error || null
  });
});

app.post('/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await registerUser({
      username: req.body.username,
      passkey: req.body.passkey,
      displayName: req.body.displayName || ''
    });
    const updates = {};
    if (req.body.role === 'admin') updates.role = 'admin';
    if (req.body.planSlug) {
      const plan = await Plan.findOne({ slug: String(req.body.planSlug) });
      if (plan) {
        updates.planSlug = plan.slug;
        updates.planId = plan._id;
      }
    }
    if (Object.keys(updates).length) {
      await User.findByIdAndUpdate(result.user.id, { $set: updates });
    }
    res.redirect('/admin/users/' + result.user.id + '?success=' + encodeURIComponent('User created'));
  } catch (error) {
    const plans = await Plan.find().sort({ sortOrder: 1 }).lean();
    res.status(400).render('admin/user-new', {
      user: req.user,
      plans,
      form: {
        username: req.body.username || '',
        displayName: req.body.displayName || ''
      },
      error: error.message
    });
  }
});

app.get('/admin/users/export.csv', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const planFilter = String(req.query.plan || 'all');
    const roleFilter = String(req.query.role || 'all');
    const statusFilter = String(req.query.status || 'all');
    const filter = {};
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ username: rx }, { displayName: rx }];
    }
    if (planFilter !== 'all') filter.planSlug = planFilter;
    if (roleFilter !== 'all') filter.role = roleFilter;
    if (statusFilter === 'active') filter.isActive = { $ne: false };
    if (statusFilter === 'disabled') filter.isActive = false;

    const users = await User.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    const header = 'id,username,displayName,role,planSlug,isActive,createdAt\n';
    const rows = users.map((u) => {
      const cells = [
        u._id.toString(),
        u.username,
        JSON.stringify(u.displayName || ''),
        u.role || 'user',
        u.planSlug || 'free',
        u.isActive === false ? 'false' : 'true',
        u.createdAt ? new Date(u.createdAt).toISOString() : ''
      ];
      return cells.join(',');
    }).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users-export.csv"');
    res.send(header + rows);
  } catch (error) {
    res.status(500).send('Export failed: ' + error.message);
  }
});

app.get('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await User.findById(req.params.id).lean();
    if (!doc) return res.redirect('/admin/users');
    const target = publicUser(doc);
    const plans = await Plan.find().sort({ sortOrder: 1 }).lean();
    const plan = plans.find((p) => p.slug === (target.planSlug || 'free')) || null;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [meetingsUsed, aiNotes, durationAgg, recentMeetings] = await Promise.all([
      Meeting.countDocuments({ userId: target.id, createdAt: { $gte: monthStart } }),
      Meeting.countDocuments({
        userId: target.id,
        createdAt: { $gte: monthStart },
        'ai.summary': { $exists: true, $ne: '' }
      }),
      Meeting.aggregate([
        { $match: { userId: target.id, createdAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$duration' } } }
      ]),
      Meeting.find({ userId: target.id }).sort({ startedAt: -1 }).limit(8).lean()
    ]);

    const maxMeetings = plan?.maxMeetingsPerMonth ?? 5;
    res.render('admin/user-detail', {
      user: req.user,
      target: { ...target, updatedAt: doc.updatedAt },
      plan,
      plans,
      usageStats: {
        meetingsUsed,
        meetingsMax: maxMeetings,
        aiNotes,
        transcriptionMinutes: Math.round((durationAgg[0]?.total || 0) / 60),
        askAi: 0
      },
      recentMeetings,
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.redirect('/admin/users?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    if (req.params.id === req.user.id && role !== 'admin') {
      return res.redirect('/admin/users/' + req.params.id + '?success=' + encodeURIComponent('You cannot demote yourself.'));
    }
    await User.findByIdAndUpdate(req.params.id, { $set: { role } });
    const back = req.get('Referer')?.includes('/admin/users/')
      ? '/admin/users/' + req.params.id
      : '/admin/users';
    res.redirect(back + '?success=' + encodeURIComponent('Role updated'));
  } catch (error) {
    res.redirect('/admin/users?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/users/:id/plan', requireAdmin, async (req, res) => {
  try {
    const plan = await Plan.findOne({ slug: String(req.body.planSlug || 'free') });
    await User.findByIdAndUpdate(req.params.id, {
      $set: {
        planSlug: plan?.slug || 'free',
        planId: plan?._id || null
      }
    });
    const back = req.get('Referer')?.includes('/admin/users/')
      ? '/admin/users/' + req.params.id
      : '/admin/users';
    res.redirect(back + '?success=' + encodeURIComponent('Plan updated'));
  } catch (error) {
    res.redirect('/admin/users?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/users/:id/toggle', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.redirect('/admin/users?success=' + encodeURIComponent('You cannot disable your own account.'));
    }
    const target = await User.findById(req.params.id);
    if (!target) return res.redirect('/admin/users');
    target.isActive = !target.isActive;
    await target.save();
    const back = req.get('Referer')?.includes('/admin/users/')
      ? '/admin/users/' + req.params.id
      : '/admin/users';
    res.redirect(back + '?success=' + encodeURIComponent(target.isActive ? 'User enabled' : 'User disabled'));
  } catch (error) {
    res.redirect('/admin/users?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.redirect('/admin/users?success=' + encodeURIComponent('You cannot delete your own account.'));
    }
    await User.findByIdAndDelete(req.params.id);
    res.redirect('/admin/users?success=' + encodeURIComponent('User deleted'));
  } catch (error) {
    res.redirect('/admin/users?success=' + encodeURIComponent(error.message));
  }
});

function parseOptionalLimit(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s.toLowerCase() === 'unlimited') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 9999) return null;
  return n;
}

function parseFeatureFlags(body = {}) {
  const keys = [
    'liveTranscription', 'aiSummaries', 'actionItems', 'askAi', 'aiInsights',
    'pdfExport', 'markdownExport', 'txtExport', 'teamWorkspace', 'adminDashboard'
  ];
  const flags = {};
  for (const k of keys) {
    flags[k] = body[`flag_${k}`] === 'on' || body[`flag_${k}`] === 'true';
  }
  return flags;
}

function parsePlanBody(body = {}, { isNew = false } = {}) {
  const features = String(body.features || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const data = {
    name: String(body.name || '').slice(0, 80),
    priceMonthly: Math.max(0, Number(body.priceMonthly || 0)),
    priceAnnual: Math.max(0, Number(body.priceAnnual || 0)),
    description: String(body.description || '').slice(0, 400),
    features,
    maxMeetingsPerMonth: parseOptionalLimit(body.maxMeetingsPerMonth),
    maxTranscriptionMinutes: parseOptionalLimit(body.maxTranscriptionMinutes),
    maxAiQuestions: parseOptionalLimit(body.maxAiQuestions),
    maxStorageGb: parseOptionalLimit(body.maxStorageGb),
    featureFlags: parseFeatureFlags(body),
    isActive: body.isActive === 'on' || body.isActive === 'true',
    isRecommended: body.isRecommended === 'on' || body.isRecommended === 'true',
    sortOrder: Number(body.sortOrder || 0)
  };
  if (isNew) {
    const slug = String(body.slug || body.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    data.slug = slug;
  }
  return data;
}

app.get('/admin/plans', requireAdmin, async (req, res) => {
  try {
    const tab = String(req.query.tab || 'plans');
    const plans = await Plan.find().sort({ sortOrder: 1 }).lean();

    const byPlan = await User.aggregate([
      { $group: { _id: '$planSlug', count: { $sum: 1 } } }
    ]);
    const subscriberCounts = Object.fromEntries(byPlan.map((r) => [r._id || 'free', r.count]));

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [totalUsers, paidUsers, freeUsers, activeUsers, newThisMonth] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ planSlug: { $nin: ['free', null, ''] }, isActive: { $ne: false } }),
      User.countDocuments({ $or: [{ planSlug: 'free' }, { planSlug: null }, { planSlug: '' }] }),
      User.countDocuments({ isActive: { $ne: false } }),
      User.countDocuments({ createdAt: { $gte: monthStart }, planSlug: { $nin: ['free', null, ''] } })
    ]);

    let mrr = 0;
    for (const p of plans) {
      const c = subscriberCounts[p.slug] || 0;
      mrr += (Number(p.priceMonthly) || 0) * c;
    }

    let subscribers = [];
    const filters = { q: String(req.query.q || '').trim(), plan: String(req.query.plan || 'all') };
    if (tab === 'subscribers') {
      const filter = {};
      if (filters.q) {
        const rx = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ username: rx }, { displayName: rx }];
      }
      if (filters.plan !== 'all') filter.planSlug = filters.plan;
      const docs = await User.find(filter).sort({ createdAt: -1 }).limit(100).lean();
      subscribers = docs.map((u) => publicUser(u));
    }

    res.render('admin/plans', {
      user: req.user,
      plans,
      activeTab: tab,
      subscriberCounts,
      subscribers,
      filters,
      billingStats: { totalUsers, paidUsers, freeUsers, activeUsers, newThisMonth, mrr },
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.status(500).render('admin/plans', {
      user: req.user,
      plans: [],
      activeTab: 'plans',
      subscriberCounts: {},
      subscribers: [],
      filters: { q: '', plan: 'all' },
      billingStats: {},
      error: error.message,
      success: null
    });
  }
});

app.get('/admin/plans/new', requireAdmin, async (req, res) => {
  res.render('admin/plan-edit', {
    user: req.user,
    plan: null,
    isNew: true,
    error: null
  });
});

app.get('/admin/plans/:id/edit', requireAdmin, async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id).lean();
    if (!plan) return res.redirect('/admin/plans');
    res.render('admin/plan-edit', {
      user: req.user,
      plan,
      isNew: false,
      error: null
    });
  } catch (error) {
    res.redirect('/admin/plans?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/plans', requireAdmin, async (req, res) => {
  try {
    const data = parsePlanBody(req.body, { isNew: true });
    if (!data.slug || !data.name) throw new Error('Name is required');
    await Plan.create(data);
    res.redirect('/admin/plans?success=' + encodeURIComponent('Plan created'));
  } catch (error) {
    res.status(400).render('admin/plan-edit', {
      user: req.user,
      plan: { ...req.body, features: String(req.body.features || '').split('\n') },
      isNew: true,
      error: error.message
    });
  }
});

app.post('/admin/plans/:id', requireAdmin, async (req, res) => {
  try {
    const data = parsePlanBody(req.body, { isNew: false });
    if (!data.name) throw new Error('Name is required');
    await Plan.findByIdAndUpdate(req.params.id, { $set: data });
    res.redirect('/admin/plans?success=' + encodeURIComponent('Plan updated'));
  } catch (error) {
    res.redirect('/admin/plans/' + req.params.id + '/edit?error=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/plans/:id/delete', requireAdmin, async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (plan?.slug === 'free') {
      return res.redirect('/admin/plans?success=' + encodeURIComponent('Cannot delete the Free plan'));
    }
    await Plan.findByIdAndDelete(req.params.id);
    res.redirect('/admin/plans?success=' + encodeURIComponent('Plan deleted'));
  } catch (error) {
    res.redirect('/admin/plans?success=' + encodeURIComponent(error.message));
  }
});


app.get('/admin/meetings', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const platformFilter = String(req.query.platform || 'all');
    const aiFilter = String(req.query.ai || 'all');
    const dateFilter = String(req.query.date || 'all');
    const userFilter = String(req.query.user || '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 25;

    const filter = {};
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { title: rx },
        { 'ai.generatedTitle': rx },
        { platform: rx },
        { userId: rx }
      ];
    }
    if (platformFilter !== 'all') {
      if (platformFilter === 'Google Meet') filter.platform = /meet|google/i;
      else if (platformFilter === 'Zoom') filter.platform = /zoom/i;
      else if (platformFilter === 'Microsoft Teams') filter.platform = /teams|microsoft/i;
      else if (platformFilter === 'Manual') filter.platform = /manual|^$/i;
      else filter.platform = platformFilter;
    }
    if (aiFilter === 'ready') filter['ai.summary'] = { $exists: true, $ne: '' };
    if (aiFilter === 'failed') filter['ai.error'] = { $exists: true, $ne: '' };
    if (aiFilter === 'pending') {
      filter.fullTranscript = { $exists: true, $ne: '' };
      filter.$and = [
        { $or: [{ 'ai.summary': { $exists: false } }, { 'ai.summary': '' }] },
        { $or: [{ 'ai.error': { $exists: false } }, { 'ai.error': '' }] }
      ];
    }
    if (aiFilter === 'none') {
      filter.$or = [{ fullTranscript: { $exists: false } }, { fullTranscript: '' }];
    }
    if (dateFilter === 'today') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      filter.createdAt = { $gte: start };
    } else if (dateFilter === '7d') {
      const start = new Date(); start.setDate(start.getDate() - 7);
      filter.createdAt = { $gte: start };
    } else if (dateFilter === '30d') {
      const start = new Date(); start.setDate(start.getDate() - 30);
      filter.createdAt = { $gte: start };
    }

    if (userFilter) {
      const matchedUsers = await User.find({
        $or: [
          { username: new RegExp(userFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { displayName: new RegExp(userFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
        ]
      }).select('_id').lean();
      const ids = matchedUsers.map((u) => u._id.toString());
      if (ids.length) filter.userId = { $in: ids };
      else filter.userId = '__none__';
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const prevMonthStart = new Date(monthStart); prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);

    const [
      total,
      meetingsRaw,
      totalAll,
      todayCount,
      aiReadyAll,
      issuesAll,
      thisMonth,
      prevMonth
    ] = await Promise.all([
      Meeting.countDocuments(filter),
      Meeting.find(filter).sort({ startedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Meeting.countDocuments(),
      Meeting.countDocuments({ createdAt: { $gte: todayStart } }),
      Meeting.countDocuments({ 'ai.summary': { $exists: true, $ne: '' } }),
      Meeting.countDocuments({ 'ai.error': { $exists: true, $ne: '' } }),
      Meeting.countDocuments({ createdAt: { $gte: monthStart } }),
      Meeting.countDocuments({ createdAt: { $gte: prevMonthStart, $lt: monthStart } })
    ]);

    const userIds = [...new Set(meetingsRaw.map((m) => m.userId).filter(Boolean))];
    const owners = await User.find({ _id: { $in: userIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)) } }).lean().catch(() => []);
    const ownerById = Object.fromEntries(owners.map((u) => [u._id.toString(), publicUser(u)]));

    const meetings = meetingsRaw.map((m) => ({
      ...m,
      owner: ownerById[m.userId] || null
    }));

    const growth = prevMonth > 0
      ? Math.round(((thisMonth - prevMonth) / prevMonth) * 1000) / 10
      : (thisMonth > 0 ? 100 : 0);
    const aiRate = totalAll > 0 ? Math.round((aiReadyAll / totalAll) * 1000) / 10 : 0;

    res.render('admin/meetings', {
      user: req.user,
      meetings,
      stats: {
        total: totalAll,
        today: todayCount,
        aiReady: aiReadyAll,
        issues: issuesAll,
        growth,
        aiRate
      },
      filters: { q, platform: platformFilter, ai: aiFilter, date: dateFilter, user: userFilter },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.status(500).render('admin/meetings', {
      user: req.user,
      meetings: [],
      stats: { total: 0, today: 0, aiReady: 0, issues: 0, growth: 0, aiRate: 0 },
      filters: { q: '', platform: 'all', ai: 'all', date: 'all', user: '' },
      pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
      error: error.message,
      success: null
    });
  }
});

app.get('/admin/meetings/export.csv', requireAdmin, async (req, res) => {
  try {
    const meetings = await Meeting.find().sort({ startedAt: -1 }).limit(5000).lean();
    const header = 'externalId,title,userId,platform,durationSec,aiReady,startedAt,createdAt\n';
    const rows = meetings.map((m) => [
      m.externalId,
      JSON.stringify(m.ai?.generatedTitle || m.title || ''),
      m.userId,
      JSON.stringify(m.platform || ''),
      m.duration || 0,
      m.ai?.summary ? 'true' : 'false',
      m.startedAt ? new Date(m.startedAt).toISOString() : '',
      m.createdAt ? new Date(m.createdAt).toISOString() : ''
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="meetings-export.csv"');
    res.send(header + rows);
  } catch (error) {
    res.status(500).send('Export failed: ' + error.message);
  }
});

app.get('/admin/meetings/:id', requireAdmin, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id }).lean();
    if (!meeting) return res.redirect('/admin/meetings');
    let ownerUser = null;
    if (meeting.userId && /^[a-f0-9]{24}$/i.test(meeting.userId)) {
      const u = await User.findById(meeting.userId).lean();
      if (u) ownerUser = publicUser(u);
    }
    res.render('admin/meeting-detail', {
      user: req.user,
      meeting,
      ownerUser,
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.redirect('/admin/meetings?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/meetings/:id/analyze', requireAdmin, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id });
    if (!meeting) return res.redirect('/admin/meetings');
    const generated = await analyzeTranscript(meeting);
    if (generated.generatedTitle) meeting.title = generated.generatedTitle;
    meeting.ai = { ...generated, generatedAt: new Date(), error: '' };
    await meeting.save();
    res.redirect('/admin/meetings/' + req.params.id + '?success=' + encodeURIComponent('AI analysis updated'));
  } catch (error) {
    try {
      await Meeting.findOneAndUpdate(
        { externalId: req.params.id },
        { $set: { 'ai.error': error.message } }
      );
    } catch (_) {}
    res.redirect('/admin/meetings/' + req.params.id + '?success=' + encodeURIComponent('Analysis failed: ' + error.message));
  }
});

app.post('/admin/meetings/:id/archive', requireAdmin, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id });
    if (!meeting) return res.redirect('/admin/meetings');
    meeting.isArchived = !meeting.isArchived;
    await meeting.save();
    const back = req.get('Referer')?.includes('/admin/meetings/')
      ? '/admin/meetings/' + req.params.id
      : '/admin/meetings';
    res.redirect(back + '?success=' + encodeURIComponent(meeting.isArchived ? 'Meeting archived' : 'Meeting unarchived'));
  } catch (error) {
    res.redirect('/admin/meetings?success=' + encodeURIComponent(error.message));
  }
});

app.post('/admin/meetings/:id/delete', requireAdmin, async (req, res) => {
  try {
    await Meeting.deleteOne({ externalId: req.params.id });
    res.redirect('/admin/meetings?success=' + encodeURIComponent('Meeting deleted'));
  } catch (error) {
    res.redirect('/admin/meetings?success=' + encodeURIComponent(error.message));
  }
});

app.get('/admin/ai-notes', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const contentFilter = String(req.query.content || 'all');
    const statusFilter = String(req.query.status || 'all');
    const planFilter = String(req.query.plan || 'all');
    const dateFilter = String(req.query.date || 'all');
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 25;

    const filter = {};
    if (statusFilter === 'ready') filter['ai.summary'] = { $exists: true, $ne: '' };
    else if (statusFilter === 'failed') filter['ai.error'] = { $exists: true, $ne: '' };
    else if (statusFilter === 'pending') {
      filter.fullTranscript = { $exists: true, $ne: '' };
      filter.$and = [
        { $or: [{ 'ai.summary': { $exists: false } }, { 'ai.summary': '' }] },
        { $or: [{ 'ai.error': { $exists: false } }, { 'ai.error': '' }] }
      ];
    } else {
      filter.$or = [
        { 'ai.summary': { $exists: true, $ne: '' } },
        { 'ai.error': { $exists: true, $ne: '' } },
        { fullTranscript: { $exists: true, $ne: '' } }
      ];
    }

    if (contentFilter === 'summary') filter['ai.summary'] = { $exists: true, $ne: '' };
    if (contentFilter === 'actions') filter['ai.actionItems.0'] = { $exists: true };
    if (contentFilter === 'insights') filter['ai.keyPoints.0'] = { $exists: true };
    if (contentFilter === 'failed') filter['ai.error'] = { $exists: true, $ne: '' };

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = (filter.$and || []).concat([{
        $or: [
          { title: rx },
          { 'ai.generatedTitle': rx },
          { 'ai.summary': rx },
          { userId: rx }
        ]
      }]);
    }

    if (dateFilter === 'today') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      filter.updatedAt = { $gte: start };
    } else if (dateFilter === '7d') {
      const start = new Date(); start.setDate(start.getDate() - 7);
      filter.updatedAt = { $gte: start };
    } else if (dateFilter === '30d') {
      const start = new Date(); start.setDate(start.getDate() - 30);
      filter.updatedAt = { $gte: start };
    }

    if (planFilter !== 'all') {
      const planUsers = await User.find({ planSlug: planFilter }).select('_id').lean();
      const ids = planUsers.map((u) => u._id.toString());
      filter.userId = { $in: ids.length ? ids : ['__none__'] };
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const prevMonthStart = new Date(monthStart); prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);

    const [
      total,
      notesRaw,
      totalAi,
      todayAi,
      withActions,
      failedCount,
      thisMonthAi,
      prevMonthAi,
      plans
    ] = await Promise.all([
      Meeting.countDocuments(filter),
      Meeting.find(filter).sort({ 'ai.generatedAt': -1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Meeting.countDocuments({ 'ai.summary': { $exists: true, $ne: '' } }),
      Meeting.countDocuments({
        'ai.summary': { $exists: true, $ne: '' },
        $or: [
          { 'ai.generatedAt': { $gte: todayStart } },
          { updatedAt: { $gte: todayStart }, 'ai.summary': { $exists: true, $ne: '' } }
        ]
      }),
      Meeting.countDocuments({ 'ai.actionItems.0': { $exists: true } }),
      Meeting.countDocuments({ 'ai.error': { $exists: true, $ne: '' } }),
      Meeting.countDocuments({ 'ai.summary': { $exists: true, $ne: '' }, createdAt: { $gte: monthStart } }),
      Meeting.countDocuments({ 'ai.summary': { $exists: true, $ne: '' }, createdAt: { $gte: prevMonthStart, $lt: monthStart } }),
      Plan.find().sort({ sortOrder: 1 }).lean()
    ]);

    const userIds = [...new Set(notesRaw.map((m) => m.userId).filter(Boolean))];
    const owners = await User.find({ _id: { $in: userIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)) } }).lean().catch(() => []);
    const ownerById = Object.fromEntries(owners.map((u) => [u._id.toString(), publicUser(u)]));
    const notes = notesRaw.map((m) => ({ ...m, owner: ownerById[m.userId] || null }));

    const growth = prevMonthAi > 0
      ? Math.round(((thisMonthAi - prevMonthAi) / prevMonthAi) * 1000) / 10
      : (thisMonthAi > 0 ? 100 : 0);
    const actionRate = totalAi > 0 ? Math.round((withActions / totalAi) * 1000) / 10 : 0;
    const failRate = (totalAi + failedCount) > 0
      ? Math.round((failedCount / Math.max(1, totalAi + failedCount)) * 1000) / 10
      : 0;
    const successRate = Math.max(0, Math.round(1000 - failRate * 10) / 10);

    const activitySeries = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      // sequential is fine for 14 days
      // eslint-disable-next-line no-await-in-loop
      const value = await Meeting.countDocuments({
        'ai.summary': { $exists: true, $ne: '' },
        $or: [
          { 'ai.generatedAt': { $gte: day, $lt: next } },
          { updatedAt: { $gte: day, $lt: next } }
        ]
      });
      activitySeries.push({
        label: day.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        short: day.toLocaleDateString([], { weekday: 'narrow' }),
        value
      });
    }

    res.render('admin/ai-notes', {
      user: req.user,
      notes,
      plans,
      stats: {
        total: totalAi,
        today: todayAi,
        withActions,
        failed: failedCount,
        growth,
        actionRate,
        failRate,
        successRate
      },
      activitySeries,
      filters: { q, content: contentFilter, status: statusFilter, plan: planFilter, date: dateFilter },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.status(500).render('admin/ai-notes', {
      user: req.user,
      notes: [],
      plans: [],
      stats: { total: 0, today: 0, withActions: 0, failed: 0, growth: 0, actionRate: 0, failRate: 0, successRate: 100 },
      activitySeries: [],
      filters: { q: '', content: 'all', status: 'all', plan: 'all', date: 'all' },
      pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
      error: error.message,
      success: null
    });
  }
});

app.get('/admin/ai-notes/export.csv', requireAdmin, async (req, res) => {
  try {
    const meetings = await Meeting.find({
      $or: [
        { 'ai.summary': { $exists: true, $ne: '' } },
        { 'ai.error': { $exists: true, $ne: '' } }
      ]
    }).sort({ updatedAt: -1 }).limit(5000).lean();
    const header = 'externalId,title,userId,hasSummary,hasActions,hasError,generatedAt\n';
    const rows = meetings.map((m) => [
      m.externalId,
      JSON.stringify(m.ai?.generatedTitle || m.title || ''),
      m.userId,
      m.ai?.summary ? 'true' : 'false',
      m.ai?.actionItems?.length ? 'true' : 'false',
      m.ai?.error ? 'true' : 'false',
      m.ai?.generatedAt ? new Date(m.ai.generatedAt).toISOString() : ''
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ai-notes-export.csv"');
    res.send(header + rows);
  } catch (error) {
    res.status(500).send('Export failed: ' + error.message);
  }
});

app.get('/admin/ai-notes/:id', requireAdmin, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id }).lean();
    if (!meeting) return res.redirect('/admin/ai-notes');
    let ownerUser = null;
    if (meeting.userId && /^[a-f0-9]{24}$/i.test(meeting.userId)) {
      const u = await User.findById(meeting.userId).lean();
      if (u) ownerUser = publicUser(u);
    }
    res.render('admin/ai-note-detail', {
      user: req.user,
      meeting,
      ownerUser,
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    res.redirect('/admin/ai-notes?success=' + encodeURIComponent(error.message));
  }
});

app.get('/admin/transcriptions', requireAdmin, async (req, res) => {
  const meetings = await Meeting.find().sort({ startedAt: -1 }).limit(100).lean();
  res.render('admin/section', {
    user: req.user,
    title: 'Transcriptions',
    activeNav: 'transcriptions',
    description: 'Monitor transcription usage and session length.',
    meetings,
    error: null,
    success: null
  });
});

app.get('/admin/analytics', requireAdmin, async (req, res) => {
  res.redirect('/admin');
});

app.get('/admin/extension', requireAdmin, async (req, res) => {
  res.render('admin/section', {
    user: req.user,
    title: 'Extension',
    activeNav: 'extension',
    description: 'Extension configuration and status. Share the install guide with users.',
    meetings: [],
    error: null,
    success: null,
    extraHtml: true
  });
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const settings = await getSiteSettings();
  res.render('admin/settings', {
    user: req.user,
    settings,
    error: null,
    success: req.query.success || null
  });
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const labels = [].concat(req.body.linkLabel || []);
    const urls = [].concat(req.body.linkUrl || []);
    const footerLinks = labels.map((label, i) => ({ label, url: urls[i] || '' }));
    await updateSiteSettings({
      siteName: req.body.siteName,
      tagline: req.body.tagline,
      authSubtitle: req.body.authSubtitle,
      footerText: req.body.footerText,
      supportEmail: req.body.supportEmail,
      copyrightText: req.body.copyrightText,
      footerLinks
    });
    res.redirect('/admin/settings?success=' + encodeURIComponent('Settings saved'));
  } catch (error) {
    res.redirect('/admin/settings?success=' + encodeURIComponent(error.message));
  }
});



app.get('/account', requireAuth, async (req, res) => {
  const success = req.query.welcome ? 'Account ready. Copy your API key into the Chrome extension.' : null;
  const settings = await getSiteSettings().catch(() => null);
  const ctx = await loadUserPlanContext(req.user);
  res.render('account', { user: req.user, error: null, success, settings, plan: ctx.plan, usage: ctx.usage });
});

app.post('/account/rotate-key', requireAuth, async (req, res) => {
  try {
    const user = await rotateApiKey(req.user.id);
    const settings = await getSiteSettings().catch(() => null);
    const ctx = await loadUserPlanContext(user);
    res.render('account', { user, error: null, success: 'API key rotated. Update the extension.', settings, plan: ctx.plan, usage: ctx.usage });
  } catch (error) {
    const settings = await getSiteSettings().catch(() => null);
    const ctx = await loadUserPlanContext(req.user).catch(() => ({ plan: null, usage: null }));
    res.status(500).render('account', { user: req.user, error: error.message, success: null, settings, plan: ctx.plan, usage: ctx.usage });
  }
});


app.get('/meetings/processing/:id', requireAuth, async (req, res) => {
  try {
    const settings = await getSiteSettings().catch(() => null);
    const ctx = await loadUserPlanContext(req.user);
    const title = String(req.query.title || 'Your meeting').slice(0, 160);
    res.render('meeting-processing', {
      user: req.user,
      meetingId: req.params.id,
      title,
      settings,
      plan: ctx.plan,
      usage: ctx.usage
    });
  } catch (error) {
    res.status(500).send(error.message);
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
    const settings = await getSiteSettings().catch(() => null);
    const ctx = await loadUserPlanContext(req.user);
    res.render('meeting', { user: req.user, meeting, error: null, success: null, settings, plan: ctx.plan, usage: ctx.usage });
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
    const back = req.body.redirect || req.get('Referer') || '/app';
    res.redirect(back);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/meetings/:id/delete', requireAuth, async (req, res) => {
  try {
    await Meeting.deleteOne({ externalId: req.params.id, userId: req.user.id });
    res.redirect('/app?success=' + encodeURIComponent('Meeting deleted'));
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
    const back = req.body.redirect || (meeting.isArchived ? '/app/meetings?view=archived' : '/app/meetings');
    res.redirect(back);
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

app.get('/api/meetings/:id/status', requireAuth, async (req, res) => {
  try {
    const requestedId = String(req.params.id);
    const state = meetingProcessingStates.get(requestedId);
    const id = state?.aliasId || requestedId;
    const meeting = await Meeting.findOne({ externalId: id, userId: req.user.id }).lean();
    if (meeting) {
      return res.json({ ok: true, status: 'completed', stage: 'ready', meetingId: id, meeting });
    }
    res.json({
      ok: true,
      status: state?.status || 'processing',
      stage: state?.stage || 'waiting',
      message: state?.message || 'Waiting for the final transcript…',
      updatedAt: state?.updatedAt || null,
      meetingId: id
    });
  } catch (error) {
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

const PARTICIPANT_COLORS = ['#e07a3d', '#6bbf8a', '#e8a0a0', '#5b8def', '#c084fc', '#fbbf24', '#34d399'];

function deriveParticipantsFromTranscript(transcript = [], fullText = '', durationSec = 0) {
  const times = {};
  if (Array.isArray(transcript) && transcript.length) {
    for (const row of transcript) {
      const name = String(row.speaker || row.name || 'Speaker').trim() || 'Speaker';
      const start = Number(row.startTime || 0);
      const end = Number(row.endTime || start);
      const sec = Math.max(0, end - start) || Math.max(1, String(row.text || '').split(/\s+/).length * 0.4);
      times[name] = (times[name] || 0) + sec;
    }
  } else if (fullText) {
    // Heuristic: "Name: text" lines
    const lines = String(fullText).split(/\n+/);
    for (const line of lines) {
      const m = line.match(/^([A-Z][A-Za-z0-9 ._-]{1,40})\s*:\s+(.+)$/);
      if (!m) continue;
      const name = m[1].trim();
      const sec = Math.max(1, m[2].split(/\s+/).length * 0.4);
      times[name] = (times[name] || 0) + sec;
    }
  }
  const entries = Object.entries(times);
  if (!entries.length) return [];
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const scale = durationSec > 0 ? durationSec / total : 1;
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, sec], i) => {
      const talkSeconds = Math.round(sec * scale);
      return {
        name,
        email: '',
        talkSeconds,
        talkPercent: Math.round((sec / total) * 1000) / 10,
        color: PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length]
      };
    });
}

app.post('/api/meetings/complete', requireAuth, async (req, res) => {
  let processingId = String(req.body?.externalId || '');
  try {
    const data = normalizeMeetingBody({ ...req.body, userId: req.user.id });
    processingId = data.externalId;

    // Same externalId = same meeting. Never run two finalizers for it.
    if (meetingProcessingLocks.has(processingId)) {
      return await meetingProcessingLocks.get(processingId).then((result) => res.json(result));
    }

    const run = (async () => {
      meetingProcessingStates.set(processingId, {
        status: 'processing', stage: 'transcript', message: 'Transcript received. Saving your meeting…', updatedAt: Date.now()
      });
    if (!data.participants?.length) {
      data.participants = deriveParticipantsFromTranscript(
        data.transcript,
        data.fullTranscript,
        data.duration
      );
    } else {
      const total = data.participants.reduce((s, p) => s + (p.talkSeconds || 0), 0);
      data.participants = data.participants.map((p, i) => ({
        ...p,
        talkPercent: p.talkPercent || (total ? Math.round((p.talkSeconds / total) * 1000) / 10 : 0),
        color: p.color || PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length]
      }));
    }
    // Idempotency guard for duplicate extension stop/start signals. A single
    // real meeting can sometimes produce two different client session IDs
    // when the meeting UI fires both a Leave event and a tab lifecycle event.
    // If the same user/platform/URL started within a short window, fold the
    // later payload into the existing session instead of creating a second row.
    let canonicalExternalId = data.externalId;
    const startedMs = new Date(data.startedAt).getTime();
    const recentWindowMs = 2 * 60 * 1000;
    const recentFilter = {
      userId: data.userId,
      platform: data.platform,
      startedAt: {
        $gte: new Date(startedMs - recentWindowMs),
        $lte: new Date(startedMs + recentWindowMs)
      },
      ...(data.meetingUrl
        ? { meetingUrl: data.meetingUrl }
        : { title: data.title })
    };
    const duplicateCandidate = await Meeting.findOne({
      ...recentFilter,
      externalId: { $ne: data.externalId }
    }).sort({ startedAt: -1 });
    if (duplicateCandidate) {
      canonicalExternalId = duplicateCandidate.externalId;
      meetingProcessingStates.set(processingId, {
        status: 'processing', stage: 'transcript', aliasId: canonicalExternalId,
        message: 'This meeting is already being finalized. Updating the existing meeting…', updatedAt: Date.now()
      });
      console.warn(`[api] duplicate session folded: ${data.externalId} -> ${canonicalExternalId}`);
    }
    data.externalId = canonicalExternalId;

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

      meetingProcessingStates.set(processingId, {
        status: 'processing', stage: 'analysis', message: 'Transcript received. Generating AI meeting insights…', updatedAt: Date.now()
      });

      // The analysis is deliberately performed after the transcript is persisted.
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

      const result = {
        ok: true,
        meeting: meeting.toObject(),
        analysisReady,
        analysisError: analysis?.error || ''
      };
      const readyState = {
        status: 'completed', stage: 'ready', aliasId: data.externalId,
        message: analysisReady ? 'Your meeting is ready.' : 'Your meeting was saved. AI analysis can be retried.', updatedAt: Date.now()
      };
      meetingProcessingStates.set(processingId, readyState);
      if (data.externalId !== processingId) meetingProcessingStates.set(data.externalId, readyState);
      setTimeout(() => {
        meetingProcessingStates.delete(processingId);
        if (data.externalId !== processingId) meetingProcessingStates.delete(data.externalId);
      }, 10 * 60 * 1000);
      return result;
    })();
    meetingProcessingLocks.set(processingId, run);
    try {
      return res.json(await run);
    } finally {
      meetingProcessingLocks.delete(processingId);
    }
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
    const promptId = req.body.promptId ? String(req.body.promptId).trim() : null;
    const question = String(req.body.question || '').trim();
    if (!promptId && !question) {
      return res.status(400).json({ ok: false, error: 'Question or promptId is required.' });
    }
    if (promptId && !MEETING_PROMPT_TEMPLATES[promptId]) {
      return res.status(400).json({ ok: false, error: 'Unknown prompt template.' });
    }
    const answer = await answerMeetingQuestion(meeting, question || MEETING_PROMPT_TEMPLATES[promptId]?.label, promptId);
    console.log(`[api] chat OK meeting=${req.params.id} prompt=${promptId || 'free'}`);
    res.json({
      ok: true,
      answer,
      promptId: promptId || null,
      promptLabel: promptId ? MEETING_PROMPT_TEMPLATES[promptId].label : null
    });
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
  .then(async () => {
    await seedDefaults();
    app.listen(port, () => {
      console.log(`AI Note Taker API listening on http://localhost:${port}`);
      console.log(`Mongo: connected | Gemini key: ${geminiKey ? 'set' : 'MISSING'}`);
      console.log(`Gemini models (in order): ${GEMINI_FALLBACKS.join(' → ')}`);
      console.log(`Landing: http://localhost:${port}/  | Admin: admin / admin123`);
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
