import crypto from 'node:crypto';
import tls from 'node:tls';
import mongoose from 'mongoose';
import { User } from './auth.js';

const emailTemplateSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true },
  category: { type: String, default: 'General' },
  description: { type: String, default: '' },
  subject: { type: String, required: true },
  preheader: { type: String, default: '' },
  bodyHtml: { type: String, required: true },
  bodyText: { type: String, default: '' },
  variables: { type: [String], default: [] },
  isActive: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

export const EmailTemplate = mongoose.models.EmailTemplate || mongoose.model('EmailTemplate', emailTemplateSchema);

const DEFAULT_TEMPLATES = [
  {
    key: 'signup-otp', name: 'Email verification OTP', category: 'Authentication', description: 'One-time code sent during account creation.',
    subject: 'Verify your AI Note Taker account — {{otp}}', preheader: 'Your verification code expires soon.',
    variables: ['siteName','username','displayName','otp','expiresMinutes'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">WELCOME TO {{siteName}}</div><h1>Verify your email address</h1><p>Hi {{displayName}}, thanks for creating your AI Note Taker account. Enter the verification code below to finish setting up your account.</p><div class="email-code">{{otp}}</div><p class="muted">This code expires in {{expiresMinutes}} minutes. If you did not create this account, you can safely ignore this email.</p><p>— The {{siteName}} team</p></div>`
  },
  {
    key: 'password-reset', name: 'Password reset', category: 'Authentication', description: 'Secure password reset link.',
    subject: 'Reset your AI Note Taker passkey', preheader: 'Use this secure link to choose a new passkey.',
    variables: ['siteName','username','displayName','resetUrl','expiresMinutes'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">ACCOUNT SECURITY</div><h1>Reset your passkey</h1><p>Hi {{displayName}}, we received a request to reset the passkey for <strong>@{{username}}</strong>.</p><p><a class="email-button" href="{{resetUrl}}">Reset passkey</a></p><p class="muted">This link expires in {{expiresMinutes}} minutes. If you did not request a reset, no action is required.</p></div>`
  },
  {
    key: 'login-success', name: 'Login notification', category: 'Security', description: 'Security notification after a successful web login.',
    subject: 'New sign-in to your {{siteName}} account', preheader: 'A successful sign-in was just detected.',
    variables: ['siteName','username','displayName','loginTime','loginLabel'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">SECURITY NOTICE</div><h1>New sign-in detected</h1><p>Hi {{displayName}}, your account <strong>@{{username}}</strong> was successfully signed in.</p><div class="email-detail"><strong>Time</strong><span>{{loginTime}}</span><strong>Method</strong><span>{{loginLabel}}</span></div><p class="muted">If this was not you, change your passkey and review your active sessions.</p></div>`
  },
  {
    key: 'welcome', name: 'Welcome after verification', category: 'Authentication', description: 'Sent after the new account is successfully verified.',
    subject: 'Welcome to {{siteName}}', preheader: 'Your account is ready — let’s capture your first meeting.',
    variables: ['siteName','username','displayName','appUrl'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">ACCOUNT READY</div><h1>Welcome, {{displayName}} 👋</h1><p>Your email is verified and your {{siteName}} account is ready to use.</p><p><a class="email-button" href="{{appUrl}}">Open AI Note Taker</a></p><p>Capture a meeting, and let AI turn the conversation into clear notes, decisions, and action items.</p></div>`
  },
  {
    key: 'upgrade-request-submitted', name: 'Upgrade request received', category: 'Billing', description: 'Confirms that a manual Pro upgrade request was submitted.',
    subject: 'We received your {{planName}} upgrade request', preheader: 'Your payment details are now waiting for admin verification.',
    variables: ['siteName','username','displayName','planName','billingInterval','amount','currency','paymentMethod','requestId','appUrl'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">BILLING REQUEST RECEIVED</div><h1>Your upgrade request is in review</h1><p>Hi {{displayName}}, we received your request to move to <strong>{{planName}}</strong>.</p><div class="email-detail"><strong>Plan</strong><span>{{planName}} · {{billingInterval}}</span><strong>Amount</strong><span>{{currency}} {{amount}}</span><strong>Payment</strong><span>{{paymentMethod}}</span><strong>Request</strong><span>#{{requestId}}</span></div><p>We’ll verify the payment manually and send you another email when the request is approved or rejected.</p><p><a class="email-button" href="{{appUrl}}">View Usage &amp; Plan</a></p></div>`
  },
  {
    key: 'upgrade-approved', name: 'Upgrade approved', category: 'Billing', description: 'Confirms that an upgrade was approved and activated.',
    subject: 'Your {{planName}} plan is now active', preheader: 'Your upgraded AI Note Taker plan is ready.',
    variables: ['siteName','username','displayName','planName','billingInterval','amount','currency','periodEnd','requestId','appUrl'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">UPGRADE APPROVED</div><h1>Your {{planName}} plan is active ✦</h1><p>Hi {{displayName}}, your manual payment was verified and your subscription has been activated.</p><div class="email-detail"><strong>Plan</strong><span>{{planName}}</span><strong>Billing</strong><span>{{billingInterval}}</span><strong>Amount</strong><span>{{currency}} {{amount}}</span><strong>Active until</strong><span>{{periodEnd}}</span></div><p><a class="email-button" href="{{appUrl}}">Start using Pro</a></p><p>Thank you for choosing {{siteName}}.</p></div>`
  },
  {
    key: 'upgrade-rejected', name: 'Upgrade request rejected', category: 'Billing', description: 'Explains that an upgrade request could not be approved.',
    subject: 'Update on your {{planName}} upgrade request', preheader: 'Your upgrade request needs attention.',
    variables: ['siteName','username','displayName','planName','requestId','reason','appUrl'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">BILLING UPDATE</div><h1>Your upgrade request was not approved</h1><p>Hi {{displayName}}, after review, we could not approve request <strong>#{{requestId}}</strong> for <strong>{{planName}}</strong>.</p><div class="email-callout"><strong>Reason</strong><br>{{reason}}</div><p>You can correct the payment details and submit a new request whenever you’re ready.</p><p><a class="email-button secondary" href="{{appUrl}}">Review Usage &amp; Plan</a></p></div>`
  },
  {
    key: 'subscription-cancelled', name: 'Subscription cancelled', category: 'Billing', description: 'Confirms a subscription cancellation and return to Free.',
    subject: 'Your {{planName}} subscription has been cancelled', preheader: 'Your account has been moved back to the Free plan.',
    variables: ['siteName','username','displayName','planName','cancelledAt','appUrl'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">SUBSCRIPTION UPDATE</div><h1>Your subscription was cancelled</h1><p>Hi {{displayName}}, your <strong>{{planName}}</strong> subscription has been cancelled and your account is now on the Free plan.</p><div class="email-detail"><strong>Cancelled</strong><span>{{cancelledAt}}</span></div><p>Your meetings and account remain available. You can upgrade again whenever you’re ready.</p><p><a class="email-button" href="{{appUrl}}">View plans</a></p></div>`
  },
  {
    key: 'meeting-created', name: 'Meeting saved', category: 'Meetings', description: 'Sent when a meeting is saved to the account.',
    subject: 'Your meeting “{{meetingTitle}}” is saved', preheader: 'Your transcript has been saved and AI processing is underway.',
    variables: ['siteName','displayName','meetingTitle','platform','meetingDate','duration','meetingUrl','meetingId','meetingUrlInApp'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">MEETING SAVED</div><h1>{{meetingTitle}}</h1><p>Hi {{displayName}}, your {{platform}} meeting has been saved successfully.</p><div class="email-detail"><strong>Date</strong><span>{{meetingDate}}</span><strong>Duration</strong><span>{{duration}}</span><strong>Meeting ID</strong><span>#{{meetingId}}</span></div><p>AI Note Taker is processing the transcript and meeting intelligence now.</p><p><a class="email-button" href="{{meetingUrlInApp}}">Open meeting</a></p></div>`
  },
  {
    key: 'meeting-summary-ready', name: 'Meeting summary ready', category: 'Meetings', description: 'Sent when AI analysis finishes successfully.',
    subject: 'AI notes are ready for “{{meetingTitle}}”', preheader: 'Your summary, decisions, and action items are ready.',
    variables: ['siteName','displayName','meetingTitle','platform','meetingDate','meetingId','meetingUrlInApp','summary'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">AI NOTES READY</div><h1>Your meeting is ready</h1><p>Hi {{displayName}}, AI has finished analyzing <strong>{{meetingTitle}}</strong>.</p><div class="email-callout">{{summary}}</div><p><a class="email-button" href="{{meetingUrlInApp}}">Review AI notes</a></p></div>`
  },
  {
    key: 'meeting-processing-failed', name: 'Meeting processing issue', category: 'Meetings', description: 'Sent when AI analysis fails and the meeting needs attention.',
    subject: 'We could not finish AI notes for “{{meetingTitle}}”', preheader: 'Your meeting is safe; AI processing needs another try.',
    variables: ['siteName','displayName','meetingTitle','meetingId','error','meetingUrlInApp'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">PROCESSING UPDATE</div><h1>AI processing needs attention</h1><p>Hi {{displayName}}, your meeting <strong>{{meetingTitle}}</strong> was saved safely, but AI analysis could not be completed.</p><div class="email-callout"><strong>Details</strong><br>{{error}}</div><p>You can open the meeting and retry analysis.</p><p><a class="email-button secondary" href="{{meetingUrlInApp}}">Open meeting</a></p></div>`
  },
  {
    key: 'action-items-ready', name: 'Action items reminder', category: 'Meetings', description: 'Optional follow-up email with outstanding action items.',
    subject: '{{actionCount}} action items from “{{meetingTitle}}”', preheader: 'Keep the next steps moving after your meeting.',
    variables: ['siteName','displayName','meetingTitle','actionCount','actionItems','meetingUrlInApp'],
    bodyHtml: `<div class="email-card"><div class="email-kicker">NEXT STEPS</div><h1>Action items to keep moving</h1><p>Hi {{displayName}}, here are the outstanding action items from <strong>{{meetingTitle}}</strong>:</p><div class="email-callout">{{actionItems}}</div><p><a class="email-button" href="{{meetingUrlInApp}}">Review action items</a></p></div>`
  }
];

export async function seedEmailTemplates() {
  for (const t of DEFAULT_TEMPLATES) {
    await EmailTemplate.updateOne({ key: t.key }, { $setOnInsert: t }, { upsert: true }).catch((e) => console.warn('[email] template seed:', e.message));
  }
}

export function getDefaultEmailTemplates() { return DEFAULT_TEMPLATES; }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}
function renderTokens(input, vars = {}) {
  return String(input ?? '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => String(vars[key] ?? ''));
}
function wrapHtml(content, preheader = '', siteName = 'AI Note Taker') {
  const css = `body{margin:0;background:#f4f6f8;color:#17202a;font-family:Inter,Arial,sans-serif} .email-wrap{padding:36px 16px}.email-shell{max-width:620px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.06)}.email-brand{padding:22px 26px;border-bottom:1px solid #eef0f3;font-weight:800;font-size:16px}.email-brand span{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:9px;background:#111;color:#fff;margin-right:8px}.email-card{padding:30px 30px 34px}.email-card h1{font-size:28px;line-height:1.18;margin:8px 0 16px}.email-card p{font-size:15px;line-height:1.7;color:#46515d}.email-kicker{font-size:11px;letter-spacing:.12em;font-weight:800;color:#687382}.email-code{font-size:34px;letter-spacing:.28em;font-weight:800;text-align:center;padding:20px;background:#f5f7fa;border:1px dashed #cfd5dc;border-radius:14px;margin:22px 0}.email-button{display:inline-block;background:#111;color:#fff!important;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:800}.email-button.secondary{background:#eef1f4;color:#111!important}.email-detail{display:grid;grid-template-columns:140px 1fr;gap:10px;padding:16px;background:#f7f8fa;border-radius:12px;margin:18px 0}.email-detail strong{color:#687382;font-size:12px}.email-detail span{font-size:13px}.email-callout{background:#f7f8fa;border-left:3px solid #111;padding:15px;border-radius:8px;font-size:14px;line-height:1.6;white-space:pre-line}.muted{color:#7a8491!important;font-size:12px!important}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(siteName)}</title><style>${css}</style></head><body><div class="email-wrap"><div class="email-shell"><div class="email-brand"><span>✦</span>${escapeHtml(siteName)}</div>${content}</div>${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>` : ''}</div></body></html>`;
}

function smtpConfig() {
  const user = process.env.GMAIL_SMTP_USER || process.env.GMAIL_USER || '';
  const pass = process.env.GMAIL_SMTP_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD || '';
  return { user, pass, host: process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.GMAIL_SMTP_PORT || 465), secure: String(process.env.GMAIL_SMTP_SECURE ?? 'true') !== 'false', fromName: process.env.GMAIL_FROM_NAME || 'AI Note Taker' };
}

function smtpSend({ to, subject, html, text, from }) {
  const cfg = smtpConfig();
  if (!cfg.user || !cfg.pass) throw new Error('Gmail SMTP is not configured. Set GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD.');
  const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: true });
  const lines = [];
  let buffer = '';
  let pending;
  let closed = false;
  const readResponse = () => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    const idx = buffer.indexOf('\n');
    if (idx >= 0) flushResponse();
  });
  const flushResponse = () => {
    if (!pending) return;
    const parts = buffer.split(/\r?\n/);
    const complete = parts.slice(0, -1);
    if (!complete.length) return;
    buffer = parts[parts.length - 1];
    const last = complete[complete.length - 1] || '';
    if (/^\d{3} /.test(last)) { const p = pending; pending = null; p.resolve(complete.join('\n')); }
  };
  socket.on('data', (d) => { buffer += d.toString('utf8'); flushResponse(); });
  return new Promise((resolve, reject) => {
    const fail = (e) => { if (closed) return; closed = true; try { socket.destroy(); } catch {} reject(e); };
    socket.on('error', fail);
    socket.on('close', () => { if (!closed) fail(new Error('SMTP connection closed unexpectedly.')); });
    (async () => {
      try {
        await new Promise((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
        let resp = await readResponse(); if (!/^220 /.test(resp.split('\n').pop())) throw new Error('Gmail SMTP greeting failed.');
        socket.write('EHLO ai-note-taker\r\n'); resp = await readResponse();
        socket.write('AUTH LOGIN\r\n'); await readResponse();
        socket.write(Buffer.from(cfg.user).toString('base64') + '\r\n'); await readResponse();
        socket.write(Buffer.from(cfg.pass.replace(/\s/g,'')).toString('base64') + '\r\n'); resp = await readResponse();
        if (!/^235 /.test(resp.split('\n').pop())) throw new Error('Gmail SMTP authentication failed. Use a Gmail App Password.');
        socket.write(`MAIL FROM:<${cfg.user}>\r\n`); resp = await readResponse();
        socket.write(`RCPT TO:<${to}>\r\n`); resp = await readResponse();
        socket.write('DATA\r\n'); await readResponse();
        const safeSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 998);
        const body = [
          `From: ${from || cfg.fromName} <${cfg.user}>`, `To: ${to}`, `Subject: ${safeSubject}`, 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="AI_NOTE_BOUNDARY"', '', '--AI_NOTE_BOUNDARY', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text || '', '', '--AI_NOTE_BOUNDARY', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', html, '', '--AI_NOTE_BOUNDARY--', ''
        ].join('\r\n');
        socket.write(body.replace(/^\./gm, '..') + '\r\n.\r\n'); resp = await readResponse();
        if (!/^250 /.test(resp.split('\n').pop())) throw new Error('Gmail SMTP rejected the message.');
        socket.write('QUIT\r\n'); await readResponse().catch(() => {}); socket.end(); closed = true; resolve(true);
      } catch (e) { fail(e); }
    })();
  });
}

export async function sendEmail({ to, templateKey, vars = {}, subject, html, text, allowUnconfigured = false }) {
  const recipient = String(to || '').trim().toLowerCase();
  if (!recipient || !recipient.includes('@')) return { ok: false, skipped: true, reason: 'missing-recipient' };
  const template = templateKey ? await EmailTemplate.findOne({ key: templateKey, isActive: true }).lean().catch(() => null) : null;
  const siteName = String(vars.siteName || process.env.GMAIL_FROM_NAME || 'AI Note Taker');
  const merged = Object.fromEntries(Object.entries(vars).map(([k,v]) => [k, escapeHtml(v)]));
  const finalSubject = subject || renderTokens(template?.subject || '', merged);
  const content = html || renderTokens(template?.bodyHtml || '', merged);
  const finalHtml = wrapHtml(content, renderTokens(template?.preheader || '', merged), siteName);
  const finalText = text || renderTokens(template?.bodyText || '', merged) || String(content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    await smtpSend({ to: recipient, subject: finalSubject, html: finalHtml, text: finalText, from: process.env.GMAIL_FROM_NAME || siteName });
    return { ok: true };
  } catch (error) {
    if (!allowUnconfigured) console.warn(`[email] ${templateKey || 'custom'} -> ${recipient}: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function sendTemplateToUser(userId, templateKey, vars = {}, options = {}) {
  const user = await User.findById(userId).select('email username displayName preferences').lean().catch(() => null);
  if (!user?.email) return { ok: false, skipped: true, reason: 'user-email-missing' };
  if (options.respectPreference !== false && user.preferences?.notifyEmail === false && !options.transactional) return { ok: false, skipped: true, reason: 'email-notifications-disabled' };
  return sendEmail({ to: user.email, templateKey, vars: { siteName: process.env.GMAIL_FROM_NAME || 'AI Note Taker', username: user.username, displayName: user.displayName || user.username, ...vars }, allowUnconfigured: options.allowUnconfigured });
}

export function createOtp() { return String(crypto.randomInt(100000, 1000000)); }
export function hashSecret(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
export function appBaseUrl() { return String(process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, ''); }
