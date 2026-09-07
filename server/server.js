import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

const app = express();
const port = Number(process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai_note_taker';
const geminiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
app.use(express.json({ limit: '2mb' }));

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
  notes: { type: String, default: '' }
}, { timestamps: true });

meetingSchema.index({ userId: 1, startedAt: -1 });
meetingSchema.index({ userId: 1, title: 'text', fullTranscript: 'text' });
const Meeting = mongoose.model('Meeting', meetingSchema);

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

async function analyzeTranscript(meeting) {
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not configured on the server.');
  const transcript = String(meeting.fullTranscript || '').trim();
  if (!transcript) return {
    generatedTitle: '',
    summary: 'No transcript was captured for this meeting.',
    detailedSummary: '',
    discussionDetails: [],
    keyPoints: [], decisions: [], decisionDetails: [], actionItems: [], topics: [], risks: [], conflicts: [], openQuestions: [], followUps: []
  };

  const prompt = `You are a meticulous AI meeting analyst. Analyze ONLY the transcript below. Never invent facts, people, dates, deadlines, decisions, action owners, disagreements, or outcomes. If information is unavailable, use an empty string, empty array, or "Not specified" only when the schema requires a string.\n\nCreate a concise meeting-specific title based on the actual subject of the discussion. The title should be 4-8 words, specific and useful in a meeting history list, not generic (avoid titles like "Meeting Notes", "Team Meeting", or "Discussion").\n\nProduce a detailed but faithful summary. Capture the purpose/context, the major discussion threads, important clarifications, requirements, constraints, decisions, and unresolved matters. Do not merely repeat the transcript.\n\nAlso identify genuine conflicts/disagreements or competing viewpoints. Only include a conflict when the transcript shows differing opinions, requirements, interpretations, priorities, or unresolved disagreement. Do not label ordinary discussion as conflict.\n\nReturn valid JSON with EXACTLY these keys:\ngeneratedTitle, summary, detailedSummary, discussionDetails, keyPoints, decisions, decisionDetails, actionItems, topics, risks, conflicts, openQuestions, followUps.\n\ndiscussionDetails must be an array of objects: {topic, details, outcome}.\ndecisionDetails must be an array of objects: {decision, rationale}.\nactionItems must be an array of objects: {task, owner, deadline, completed}.\nconflicts must be an array of objects: {topic, perspectives, impact, resolution, status}.\nopenQuestions must contain questions that remain unanswered or require confirmation.\n\nRules:\n- Use only the transcript.\n- Do not fabricate participant names.\n- Do not invent deadlines or owners.\n- Do not infer agreement when none is stated.\n- Preserve important numbers, time windows, requirements, and constraints accurately.\n- If there is no real conflict, return conflicts as [].\n- If there are no open questions, return openQuestions as [].\n- Keep the title short and meeting-specific.\n- Keep summary around 1-2 strong paragraphs.\n- Make detailedSummary substantially richer than summary, around 3-6 paragraphs.\n- Keep each discussionDetails.details and outcome concise but informative.\n\nMEETING TITLE CURRENTLY: ${meeting.title}\nPLATFORM: ${meeting.platform}\n\nTRANSCRIPT:\n${transcript}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed (${response.status})`);
  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';
  const parsed = JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
  return {
    generatedTitle: String(parsed.generatedTitle || '').trim().slice(0, 160),
    summary: String(parsed.summary || ''),
    detailedSummary: String(parsed.detailedSummary || ''),
    discussionDetails: Array.isArray(parsed.discussionDetails) ? parsed.discussionDetails.slice(0, 30).map((x) => ({
      topic: String(x?.topic || ''), details: String(x?.details || ''), outcome: String(x?.outcome || '')
    })) : [],
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String).slice(0, 30) : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String).slice(0, 30) : [],
    decisionDetails: Array.isArray(parsed.decisionDetails) ? parsed.decisionDetails.slice(0, 30).map((x) => ({
      decision: String(x?.decision || ''), rationale: String(x?.rationale || '')
    })) : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 50).map((x) => ({
      task: String(x?.task || ''), owner: String(x?.owner || ''), deadline: String(x?.deadline || ''), completed: Boolean(x?.completed)
    })) : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics.map(String).slice(0, 30) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 30) : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.slice(0, 30).map((x) => ({
      topic: String(x?.topic || ''), perspectives: String(x?.perspectives || ''), impact: String(x?.impact || ''), resolution: String(x?.resolution || ''), status: String(x?.status || '')
    })) : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(String).slice(0, 30) : [],
    followUps: Array.isArray(parsed.followUps) ? parsed.followUps.map(String).slice(0, 30) : []
  };
}
async function answerMeetingQuestion(meeting, question) {
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not configured on the server.');
  const prompt = `Answer the user's question using ONLY the meeting context below. If the answer is not present, say that it is not available in the transcript. Do not invent facts.\n\nMEETING: ${meeting.title}\nSUMMARY: ${meeting.ai?.summary || ''}\nTRANSCRIPT:\n${meeting.fullTranscript || ''}\n\nQUESTION:\n${question}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed (${response.status})`);
  return payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || 'No answer generated.';
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mongo: mongoose.connection.readyState === 1, gemini: Boolean(geminiKey) }));

app.get('/api/meetings', async (req, res) => {
  try {
    const userId = String(req.query.userId || 'local-user');
    const q = String(req.query.q || '').trim();
    const filter = { userId };
    if (q) filter.$text = { $search: q };
    const meetings = await Meeting.find(filter).sort({ startedAt: -1 }).limit(100).lean();
    res.json({ ok: true, meetings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/meetings/:id', async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: String(req.query.userId || 'local-user') }).lean();
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    res.json({ ok: true, meeting });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/meetings/complete', async (req, res) => {
  try {
    const data = normalizeMeetingBody(req.body);
    const meeting = await Meeting.findOneAndUpdate(
      { externalId: data.externalId, userId: data.userId },
      { $set: data },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    let analysis = meeting.ai || {};
    try {
      const generated = await analyzeTranscript(meeting);
      analysis = { ...generated, generatedAt: new Date(), error: '' };
      if (generated.generatedTitle) meeting.title = generated.generatedTitle;
      meeting.ai = analysis;
      await meeting.save();
    } catch (error) {
      meeting.ai = { ...(meeting.ai || {}), error: error.message, generatedAt: null };
      await meeting.save();
    }

    res.json({ ok: true, meeting: meeting.toObject(), analysisReady: Boolean(analysis?.summary) && !analysis?.error });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/meetings/:id/analyze', async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: String(req.body.userId || 'local-user') });
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    const generated = await analyzeTranscript(meeting);
    if (generated.generatedTitle) meeting.title = generated.generatedTitle;
    meeting.ai = { ...generated, generatedAt: new Date(), error: '' };
    await meeting.save();
    res.json({ ok: true, meeting: meeting.toObject() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/meetings/:id/chat', async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ externalId: req.params.id, userId: String(req.body.userId || 'local-user') }).lean();
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ ok: false, error: 'Question is required.' });
    const answer = await answerMeetingQuestion(meeting, question);
    res.json({ ok: true, answer });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/meetings/:id', async (req, res) => {
  try {
    const userId = String(req.body.userId || 'local-user');
    const allowed = {};
    for (const key of ['title', 'notes']) if (req.body[key] !== undefined) allowed[key] = String(req.body[key]);
    if (req.body.ai) allowed.ai = req.body.ai;
    const meeting = await Meeting.findOneAndUpdate({ externalId: req.params.id, userId }, { $set: allowed }, { returnDocument: 'after' }).lean();
    if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
    res.json({ ok: true, meeting });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/meetings/:id', async (req, res) => {
  try {
    const result = await Meeting.deleteOne({ externalId: req.params.id, userId: String(req.query.userId || 'local-user') });
    res.json({ ok: true, deleted: result.deletedCount > 0 });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

mongoose.connect(mongoUri)
  .then(() => app.listen(port, () => console.log(`AI Note Taker API listening on http://localhost:${port}`)))
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
