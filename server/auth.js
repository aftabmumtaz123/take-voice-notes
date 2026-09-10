/**
 * Auth: username + passkey, session cookies for web, API keys for the extension.
 * Roles: user | admin. Plans: free / paid SaaS tiers.
 */
import crypto from "node:crypto";
import mongoose from "mongoose";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const planSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  priceMonthly: { type: Number, default: 0 },
  priceAnnual: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },
  description: { type: String, default: "" },
  features: { type: [String], default: [] },
  // null / undefined / -1 means unlimited
  maxMeetingsPerMonth: { type: Number, default: 20 },
  maxTranscriptionMinutes: { type: Number, default: 60 },
  maxAiQuestions: { type: Number, default: 20 },
  maxStorageGb: { type: Number, default: 1 },
  featureFlags: {
    liveTranscription: { type: Boolean, default: true },
    aiSummaries: { type: Boolean, default: true },
    actionItems: { type: Boolean, default: true },
    askAi: { type: Boolean, default: false },
    aiInsights: { type: Boolean, default: false },
    pdfExport: { type: Boolean, default: false },
    markdownExport: { type: Boolean, default: false },
    txtExport: { type: Boolean, default: true },
    teamWorkspace: { type: Boolean, default: false },
    adminDashboard: { type: Boolean, default: false }
  },
  isActive: { type: Boolean, default: true },
  isRecommended: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

export const Plan = mongoose.models.Plan || mongoose.model("Plan", planSchema);

const siteSettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: "site" },
  siteName: { type: String, default: "AI Note Taker" },
  tagline: { type: String, default: "Focus on the meeting, let AI handle the notes." },
  authSubtitle: {
    type: String,
    default: "Turn meeting conversations into actionable outcomes. Log in or sign up to access transcripts, AI summaries, and workflows."
  },
  footerText: { type: String, default: "The easiest way to transcribe, summarize, and act on meetings." },
  footerLinks: [{
    label: { type: String, default: "" },
    url: { type: String, default: "" }
  }],
  supportEmail: { type: String, default: "" },
  copyrightText: { type: String, default: "" }
}, { timestamps: true });

export const SiteSettings = mongoose.models.SiteSettings || mongoose.model("SiteSettings", siteSettingsSchema);

const DEFAULT_FOOTER_LINKS = [
  { label: "Product", url: "/#features" },
  { label: "Pricing", url: "/#pricing" },
  { label: "Security", url: "/#security" },
  { label: "Log in", url: "/login" },
  { label: "Sign up", url: "/register" }
];

export async function getSiteSettings() {
  let doc = await SiteSettings.findOne({ key: "site" }).lean();
  if (!doc) {
    const created = await SiteSettings.create({
      key: "site",
      siteName: "AI Note Taker",
      tagline: "Focus on the meeting, let AI handle the notes.",
      authSubtitle: "Turn meeting conversations into actionable outcomes. Log in or sign up to access transcripts, AI summaries, and workflows.",
      footerText: "The easiest way to transcribe, summarize, and act on meetings.",
      footerLinks: DEFAULT_FOOTER_LINKS,
      supportEmail: "",
      copyrightText: ""
    });
    doc = created.toObject();
  }
  if (!doc.footerLinks || !doc.footerLinks.length) {
    doc.footerLinks = DEFAULT_FOOTER_LINKS;
  }
  return doc;
}

export async function updateSiteSettings(payload = {}) {
  const footerLinks = Array.isArray(payload.footerLinks)
    ? payload.footerLinks
        .map((l) => ({
          label: String(l.label || "").trim().slice(0, 60),
          url: String(l.url || "").trim().slice(0, 500)
        }))
        .filter((l) => l.label && l.url)
        .slice(0, 20)
    : undefined;

  const $set = {
    siteName: String(payload.siteName || "AI Note Taker").slice(0, 80),
    tagline: String(payload.tagline || "").slice(0, 200),
    authSubtitle: String(payload.authSubtitle || "").slice(0, 400),
    footerText: String(payload.footerText || "").slice(0, 300),
    supportEmail: String(payload.supportEmail || "").slice(0, 120),
    copyrightText: String(payload.copyrightText || "").slice(0, 120)
  };
  if (footerLinks) $set.footerLinks = footerLinks;

  const doc = await SiteSettings.findOneAndUpdate(
    { key: "site" },
    { $set },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
  return doc;
}

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    minlength: 3,
    maxlength: 32
  },
  // Optional for Google-only accounts
  passkeyHash: { type: String, default: "" },
  passkeySalt: { type: String, default: "" },
  displayName: { type: String, default: "" },
  email: { type: String, default: "", index: true },
  emailVerified: { type: Boolean, default: false },
  emailOtpHash: { type: String, default: "" },
  emailOtpExpiresAt: { type: Date, default: null },
  emailOtpAttempts: { type: Number, default: 0 },
  passwordResetTokenHash: { type: String, default: "" },
  passwordResetExpiresAt: { type: Date, default: null },
  avatarUrl: { type: String, default: "" },
  googleId: { type: String, default: "", index: true, sparse: true },
  googleTokens: {
    accessToken: { type: String, default: "" },
    refreshToken: { type: String, default: "" },
    expiryDate: { type: Number, default: 0 },
    scope: { type: String, default: "" }
  },
  role: { type: String, enum: ["user", "admin"], default: "user", index: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
  planSlug: { type: String, default: "free" },
  askAiUsageMonth: { type: String, default: "" },
  askAiUsageCount: { type: Number, default: 0 },
  apiKey: { type: String, unique: true, sparse: true, index: true },
  isActive: { type: Boolean, default: true },
  onboardingCompleted: { type: Boolean, default: false },
  onboarding: {
    useCase: { type: String, default: "" },
    heardFrom: { type: String, default: "" },
    completedAt: Date
  },
  preferences: {
    appearance: { type: String, enum: ["system", "light", "dark"], default: "light" },
    language: { type: String, default: "English" },
    dateFormat: { type: String, default: "DD MMM YYYY" },
    timezone: { type: String, default: "Asia/Karachi" },
    defaultMeetingView: { type: String, default: "timeline" },
    defaultTitleMode: { type: String, default: "platform" },
    autoSummary: { type: Boolean, default: true },
    autoActionItems: { type: Boolean, default: true },
    autoDecisions: { type: Boolean, default: true },
    saveTranscript: { type: Boolean, default: true },
    visibility: { type: String, default: "private" },
    summaryStyle: { type: String, default: "detailed" },
    detectResponsible: { type: Boolean, default: true },
    detectDueDates: { type: Boolean, default: true },
    detectPriority: { type: Boolean, default: true },
    aiLanguage: { type: String, default: "English" },
    transcriptOutput: { type: String, default: "Roman / Latin" },
    includeTimestamps: { type: Boolean, default: true },
    identifySpeakers: { type: Boolean, default: true },
    showSpeakerLabels: { type: Boolean, default: true },
    autoScrollTranscript: { type: Boolean, default: true },
    saveRawTranscript: { type: Boolean, default: true },
    notifySummaryReady: { type: Boolean, default: true },
    notifyProcessingFailure: { type: Boolean, default: true },
    notifyActionItems: { type: Boolean, default: true },
    notifyWeeklyInsights: { type: Boolean, default: true },
    notifyProductUpdates: { type: Boolean, default: false },
    notifyInApp: { type: Boolean, default: true },
    notifyEmail: { type: Boolean, default: true },
    storeRecordings: { type: Boolean, default: true },
    storeTranscripts: { type: Boolean, default: true },
    defaultExportFormat: { type: String, default: "PDF" },
    exportSummary: { type: Boolean, default: true },
    exportTranscript: { type: Boolean, default: true },
    exportActionItems: { type: Boolean, default: true },
    exportDecisions: { type: Boolean, default: true },
    filenameFormat: { type: String, default: "Meeting Title - Date" }
  },
  apiKeyCreatedAt: { type: Date, default: Date.now },
  apiKeyLastUsedAt: { type: Date, default: null },
  sessions: [{
    tokenHash: String,
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date,
    label: { type: String, default: "web" }
  }]
}, { timestamps: true });

userSchema.index({ username: 1 });
userSchema.index({ "sessions.tokenHash": 1 });

export const User = mongoose.models.User || mongoose.model("User", userSchema);

function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

function hashPasskey(passkey, saltBuf) {
  return crypto.scryptSync(String(passkey), saltBuf, 64, SCRYPT_OPTS).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function validateCredentials(username, passkey) {
  const u = normalizeUsername(username);
  const p = String(passkey || "");
  if (u.length < 3 || u.length > 32) return "Username must be 3–32 characters.";
  if (!/^[a-z0-9_]+$/.test(u)) return "Username may only use letters, numbers, and underscore.";
  if (p.length < 6) return "Passkey must be at least 6 characters.";
  if (p.length > 128) return "Passkey is too long.";
  return null;
}

function ensureApiKey(user) {
  if (user.apiKey) return user.apiKey;
  user.apiKey = `ntk_${crypto.randomBytes(24).toString("base64url")}`;
  user.apiKeyCreatedAt = new Date();
  user.apiKeyLastUsedAt = null;
  return user.apiKey;
}

export function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    displayName: user.displayName || user.username,
    email: user.email || "",
    emailVerified: Boolean(user.emailVerified),
    avatarUrl: user.avatarUrl || "",
    googleId: user.googleId || "",
    role: user.role || "user",
    planSlug: user.planSlug || "free",
    planId: user.planId ? user.planId.toString() : null,
    apiKeyConfigured: Boolean(user.apiKey),
    apiKeyLastUsedAt: user.apiKeyLastUsedAt || null,
    isActive: user.isActive !== false,
    onboardingCompleted: Boolean(user.onboardingCompleted),
    onboarding: user.onboarding || null,
    createdAt: user.createdAt
  };
}

export function postLoginRedirect(user) {
  if (user?.role === "admin") return "/admin";
  if (user && !user.onboardingCompleted) return "/onboarding";
  return "/app/overview";
}

export function isPaidPlan(slug) {
  const s = String(slug || "free").toLowerCase();
  return s !== "free" && s !== "";
}

export function planBadgeLabel(slug) {
  const s = String(slug || "free").toLowerCase();
  if (s === "team") return "TEAM";
  if (s === "premium" || s === "business") return "PREMIUM";
  if (s === "pro") return "PRO";
  return "FREE";
}

/** Treat null, undefined, -1, or >= 9999 as unlimited */
export function isUnlimited(limit) {
  if (limit == null) return true;
  const n = Number(limit);
  return !Number.isFinite(n) || n < 0 || n >= 9999;
}

export function formatLimit(limit, unit = "") {
  if (isUnlimited(limit)) return "Unlimited";
  const n = Number(limit) || 0;
  return unit ? `${n} ${unit}` : String(n);
}


export async function registerUser({ username, passkey, displayName = "", email = "" }) {
  const err = validateCredentials(username, passkey);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const u = normalizeUsername(username);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error("A valid email address is required to verify your account."), { status: 400 });
  }
  if (await User.findOne({ username: u })) {
    throw Object.assign(new Error("Username is already taken."), { status: 409 });
  }
  const freePlan = await Plan.findOne({ slug: "free", isActive: true }).lean();
  const salt = crypto.randomBytes(16);
  const user = await User.create({
    username: u,
    passkeyHash: hashPasskey(passkey, salt),
    passkeySalt: salt.toString("hex"),
    displayName: String(displayName || u).slice(0, 80),
    email: normalizedEmail,
    emailVerified: false,
    role: "user",
    planId: freePlan?._id || null,
    planSlug: freePlan?.slug || "free",
    apiKey: `ntk_${crypto.randomBytes(24).toString("base64url")}`
  });
  return { user: publicUser(user) };
}

export async function loginUser({ username, passkey, label = "web" }) {
  const err = validateCredentials(username, passkey);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const user = await User.findOne({ username: normalizeUsername(username) });
  if (!user) throw Object.assign(new Error("Invalid username or passkey."), { status: 401 });
  if (user.isActive === false) throw Object.assign(new Error("Account is disabled."), { status: 403 });
  if (user.email && user.emailVerified === false) {
    throw Object.assign(new Error("Please verify your email before logging in."), { status: 403, code: "EMAIL_NOT_VERIFIED", username: user.username });
  }
  if (!user.passkeyHash || !user.passkeySalt) {
    throw Object.assign(new Error("This account uses Google sign-in. Continue with Google."), { status: 401 });
  }
  const salt = Buffer.from(user.passkeySalt, "hex");
  const attempt = hashPasskey(passkey, salt);
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(user.passkeyHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Invalid username or passkey."), { status: 401 });
  }
  ensureApiKey(user);
  await user.save();
  const session = await createSession(user, label);
  return { user: publicUser(user), ...session };
}

function usernameFromEmail(email) {
  const base = String(email || "user")
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24) || "user";
  return base;
}

export async function findOrCreateGoogleUser({
  googleId,
  email,
  displayName,
  avatarUrl,
  tokens = {}
}) {
  if (!googleId) throw Object.assign(new Error("Missing Google user id."), { status: 400 });

  let user = await User.findOne({ googleId: String(googleId) });
  if (!user && email) {
    user = await User.findOne({ email: String(email).toLowerCase() });
  }

  const freePlan = await Plan.findOne({ slug: "free", isActive: true }).lean();

  if (!user) {
    let uname = usernameFromEmail(email);
    let n = 0;
    while (await User.findOne({ username: uname })) {
      n += 1;
      uname = `${usernameFromEmail(email)}${n}`.slice(0, 32);
    }
    user = await User.create({
      username: uname,
      passkeyHash: "",
      passkeySalt: "",
      displayName: String(displayName || uname).slice(0, 80),
      email: String(email || "").toLowerCase().slice(0, 200),
      emailVerified: true,
      avatarUrl: String(avatarUrl || "").slice(0, 500),
      googleId: String(googleId),
      googleTokens: {
        accessToken: tokens.accessToken || "",
        refreshToken: tokens.refreshToken || "",
        expiryDate: tokens.expiryDate || 0,
        scope: tokens.scope || ""
      },
      role: "user",
      planId: freePlan?._id || null,
      planSlug: freePlan?.slug || "free",
      apiKey: `ntk_${crypto.randomBytes(24).toString("base64url")}`,
      onboardingCompleted: false
    });
  } else {
    user.googleId = String(googleId);
    if (email) { user.email = String(email).toLowerCase().slice(0, 200); user.emailVerified = true; }
    if (displayName) user.displayName = String(displayName).slice(0, 80);
    if (avatarUrl) user.avatarUrl = String(avatarUrl).slice(0, 500);
    if (tokens.accessToken) {
      user.googleTokens = {
        accessToken: tokens.accessToken || user.googleTokens?.accessToken || "",
        refreshToken: tokens.refreshToken || user.googleTokens?.refreshToken || "",
        expiryDate: tokens.expiryDate || user.googleTokens?.expiryDate || 0,
        scope: tokens.scope || user.googleTokens?.scope || ""
      };
    }
    if (user.isActive === false) {
      throw Object.assign(new Error("Account is disabled."), { status: 403 });
    }
    ensureApiKey(user);
    await user.save();
  }

  const session = await createSession(user, "google");
  return { user: publicUser(user), ...session };
}

export async function createSession(user, label = "web") {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  user.sessions = (user.sessions || []).filter((s) => s.expiresAt > new Date()).slice(-9);
  user.sessions.push({ tokenHash, expiresAt, label, createdAt: new Date() });
  await user.save();
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    userId: user._id.toString(),
    username: user.username,
    apiKey: user.apiKey,
    role: user.role || "user"
  };
}

export async function logoutUser(token) {
  if (!token) return;
  const th = hashToken(token);
  await User.updateOne({ "sessions.tokenHash": th }, { $pull: { sessions: { tokenHash: th } } });
}

export async function updateAccountSettings(userId, updates = {}) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  const allowedProfile = ["displayName", "username", "email"];
  for (const key of allowedProfile) {
    if (updates[key] !== undefined) user[key] = String(updates[key] || "").trim().slice(0, key === "email" ? 200 : 80);
  }
  if (updates.username !== undefined) {
    const username = normalizeUsername(updates.username);
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw Object.assign(new Error("Username may only use 3–32 letters, numbers, and underscore."), { status: 400 });
    user.username = username;
  }
  const prefs = updates.preferences || {};
  for (const [key, value] of Object.entries(prefs)) {
    if (Object.prototype.hasOwnProperty.call(user.preferences || {}, key)) user.preferences[key] = value;
  }
  await user.save();
  return publicUser(user);
}

export async function verifyPasskey(userId, passkey) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  if (!user.passkeyHash || !user.passkeySalt) throw Object.assign(new Error("This account does not use a passkey."), { status: 400 });
  const current = hashPasskey(String(passkey || ""), Buffer.from(user.passkeySalt, "hex"));
  if (!crypto.timingSafeEqual(Buffer.from(current, "hex"), Buffer.from(user.passkeyHash, "hex"))) throw Object.assign(new Error("Passkey is incorrect."), { status: 400 });
  return true;
}

export async function resetPasskey(userId, newPasskey) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  const p = String(newPasskey || "");
  if (p.length < 6 || p.length > 128) throw Object.assign(new Error("Passkey must be 6–128 characters."), { status: 400 });
  const salt = crypto.randomBytes(16);
  user.passkeySalt = salt.toString("hex");
  user.passkeyHash = hashPasskey(p, salt);
  user.passwordResetTokenHash = "";
  user.passwordResetExpiresAt = null;
  user.sessions = [];
  await user.save();
  return publicUser(user);
}

export async function changePasskey(userId, currentPasskey, newPasskey) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  if (!user.passkeyHash || !user.passkeySalt) throw Object.assign(new Error("This account does not use a passkey."), { status: 400 });
  const current = hashPasskey(String(currentPasskey || ""), Buffer.from(user.passkeySalt, "hex"));
  if (!crypto.timingSafeEqual(Buffer.from(current, "hex"), Buffer.from(user.passkeyHash, "hex"))) {
    throw Object.assign(new Error("Current passkey is incorrect."), { status: 400 });
  }
  const err = validateCredentials(user.username, newPasskey);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const salt = crypto.randomBytes(16);
  user.passkeySalt = salt.toString("hex");
  user.passkeyHash = hashPasskey(String(newPasskey), salt);
  await user.save();
  return publicUser(user);
}

export async function deleteAllMeetings(userId, MeetingModel) {
  return MeetingModel.deleteMany({ userId });
}

export async function deleteAccount(userId, MeetingModel) {
  if (MeetingModel) await MeetingModel.deleteMany({ userId });
  await User.deleteOne({ _id: userId });
}

export async function rotateApiKey(userId) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  user.apiKey = `ntk_${crypto.randomBytes(24).toString("base64url")}`;
  user.apiKeyCreatedAt = new Date();
  user.apiKeyLastUsedAt = null;
  await user.save();
  return publicUser(user);
}

function parseCookie(header = "") {
  const out = {};
  String(header).split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export async function resolveUser(req) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const apiKeyHeader = String(req.headers["x-api-key"] || "").trim();
  const cookieToken = parseCookie(req.headers.cookie).note_session || "";
  const token = bearer || apiKeyHeader || cookieToken;
  if (!token) return null;

  if (token.startsWith("ntk_") || apiKeyHeader) {
    const key = apiKeyHeader || token;
    const user = await User.findOne({ apiKey: key });
    if (!user || user.isActive === false) return null;
    User.updateOne({ _id: user._id }, { $set: { apiKeyLastUsedAt: new Date() } }).catch(() => {});
    return publicUser(user);
  }

  const user = await User.findOne({
    "sessions.tokenHash": hashToken(token),
    "sessions.expiresAt": { $gt: new Date() }
  });
  if (!user || user.isActive === false) return null;
  return publicUser(user);
}

function wantsHtml(req) {
  const accept = req.headers.accept || "";
  return accept.includes("text/html") && !(req.path || "").startsWith("/api/");
}

export async function requireAuth(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      if (wantsHtml(req)) return res.redirect("/login");
      return res.status(401).json({ ok: false, error: "Not authenticated.", code: "AUTH_REQUIRED" });
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      if (wantsHtml(req)) return res.redirect("/login");
      return res.status(401).json({ ok: false, error: "Not authenticated." });
    }
    if (user.role !== "admin") {
      if (wantsHtml(req)) return res.redirect("/app");
      return res.status(403).json({ ok: false, error: "Admin access required." });
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function optionalAuth(req, _res, next) {
  try { req.user = await resolveUser(req); } catch (_) { req.user = null; }
  next();
}

export function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `note_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "note_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}


export async function completeOnboarding(userId, { useCase = "", heardFrom = "" } = {}) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  user.onboarding = {
    useCase: String(useCase || "").slice(0, 80),
    heardFrom: String(heardFrom || "").slice(0, 120),
    completedAt: new Date()
  };
  user.onboardingCompleted = true;
  await user.save();
  return publicUser(user);
}

/** Seed default plans + first admin (admin / admin123) if missing */
export async function seedDefaults() {
  const planCount = await Plan.countDocuments();
  if (planCount === 0) {
    await Plan.insertMany([
      {
        name: "Free",
        slug: "free",
        priceMonthly: 0,
        priceAnnual: 0,
        description: "Get started with AI-powered meeting notes.",
        features: [
          "3 meetings / month",
          "30 transcription minutes / month",
          "20 AI questions / month",
          "Live transcription",
          "AI summaries",
          "Action items",
          "Chrome extension",
          "Basic exports"
        ],
        maxMeetingsPerMonth: 3,
        maxTranscriptionMinutes: 30,
        maxAiQuestions: 20,
        maxStorageGb: 1,
        featureFlags: {
          liveTranscription: true,
          aiSummaries: true,
          actionItems: true,
          askAi: true,
          aiInsights: false,
          pdfExport: false,
          markdownExport: false,
          txtExport: true,
          teamWorkspace: false,
          adminDashboard: false
        },
        isActive: true,
        isRecommended: false,
        sortOrder: 0
      },
      {
        name: "Pro",
        slug: "pro",
        priceMonthly: 12,
        priceAnnual: 120,
        description: "Advanced AI meeting intelligence for individuals.",
        features: [
          "Unlimited meetings",
          "Extended transcription",
          "Detailed AI summaries",
          "Action items",
          "Ask AI",
          "AI Insights",
          "PDF / Markdown / TXT export",
          "Meeting history",
          "Priority processing"
        ],
        maxMeetingsPerMonth: null,
        maxTranscriptionMinutes: null,
        maxAiQuestions: null,
        maxStorageGb: 10,
        featureFlags: {
          liveTranscription: true,
          aiSummaries: true,
          actionItems: true,
          askAi: true,
          aiInsights: true,
          pdfExport: true,
          markdownExport: true,
          txtExport: true,
          teamWorkspace: false,
          adminDashboard: false
        },
        isActive: true,
        isRecommended: true,
        sortOrder: 1
      },
      {
        name: "Team",
        slug: "team",
        priceMonthly: 29,
        priceAnnual: 290,
        description: "AI Notes for teams that collaborate on meetings.",
        features: [
          "Everything in Pro",
          "Team workspace",
          "Multiple team members",
          "Shared meetings",
          "Team AI insights",
          "Admin controls",
          "Team usage analytics",
          "Priority support"
        ],
        maxMeetingsPerMonth: null,
        maxTranscriptionMinutes: null,
        maxAiQuestions: null,
        maxStorageGb: 50,
        featureFlags: {
          liveTranscription: true,
          aiSummaries: true,
          actionItems: true,
          askAi: true,
          aiInsights: true,
          pdfExport: true,
          markdownExport: true,
          txtExport: true,
          teamWorkspace: true,
          adminDashboard: true
        },
        isActive: false,
        isRecommended: false,
        sortOrder: 2
      }
    ]);
    console.log("[seed] Default plans created (free, pro, team)");
  }

  // Keep the current product limited to Free + Pro while remaining safe for existing databases.
  const free = await Plan.findOne({ slug: "free" });
  const pro = await Plan.findOne({ slug: "pro" });
  if (free) await Plan.updateOne({ _id: free._id }, { $set: { maxMeetingsPerMonth: 3, maxTranscriptionMinutes: 30, maxAiQuestions: 20, isActive: true, isRecommended: false, sortOrder: 0 } });
  if (pro) await Plan.updateOne({ _id: pro._id }, { $set: { maxMeetingsPerMonth: null, maxTranscriptionMinutes: null, maxAiQuestions: null, isActive: true, isRecommended: true, sortOrder: 1 } });
  await Plan.updateMany({ slug: "team" }, { $set: { isActive: false, isRecommended: false } });
  if (pro) await User.updateMany({ planSlug: "team" }, { $set: { planSlug: "pro", planId: pro._id } });

  const admin = await User.findOne({ username: "admin" });
  if (!admin) {
    const freePlan = await Plan.findOne({ slug: "free" });
    const salt = crypto.randomBytes(16);
    await User.create({
      username: "admin",
      passkeyHash: hashPasskey("admin123", salt),
      passkeySalt: salt.toString("hex"),
      displayName: "Administrator",
      role: "admin",
      planId: pro?._id || freePlan?._id || null,
      planSlug: pro ? "pro" : "free",
      apiKey: `ntk_${crypto.randomBytes(24).toString("base64url")}`
    });
    console.log("[seed] Admin user created — username: admin / passkey: admin123");
  }

  await getSiteSettings();
}
