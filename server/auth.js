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
  currency: { type: String, default: "USD" },
  description: { type: String, default: "" },
  features: { type: [String], default: [] },
  maxMeetingsPerMonth: { type: Number, default: 20 },
  isActive: { type: Boolean, default: true },
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
  passkeyHash: { type: String, required: true },
  passkeySalt: { type: String, required: true },
  displayName: { type: String, default: "" },
  role: { type: String, enum: ["user", "admin"], default: "user", index: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
  planSlug: { type: String, default: "free" },
  apiKey: { type: String, unique: true, sparse: true, index: true },
  isActive: { type: Boolean, default: true },
  onboardingCompleted: { type: Boolean, default: false },
  onboarding: {
    useCase: { type: String, default: "" },
    heardFrom: { type: String, default: "" },
    completedAt: Date
  },
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
  return user.apiKey;
}

export function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "user",
    planSlug: user.planSlug || "free",
    planId: user.planId ? user.planId.toString() : null,
    apiKey: user.apiKey || null,
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
  if (s === "team" || s === "premium" || s === "business") return "PREMIUM";
  if (s === "pro") return "PRO";
  return "FREE";
}


export async function registerUser({ username, passkey, displayName = "" }) {
  const err = validateCredentials(username, passkey);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const u = normalizeUsername(username);
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
    role: "user",
    planId: freePlan?._id || null,
    planSlug: freePlan?.slug || "free",
    apiKey: `ntk_${crypto.randomBytes(24).toString("base64url")}`
  });
  const session = await createSession(user, "web");
  return { user: publicUser(user), ...session };
}

export async function loginUser({ username, passkey, label = "web" }) {
  const err = validateCredentials(username, passkey);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const user = await User.findOne({ username: normalizeUsername(username) });
  if (!user) throw Object.assign(new Error("Invalid username or passkey."), { status: 401 });
  if (user.isActive === false) throw Object.assign(new Error("Account is disabled."), { status: 403 });
  const salt = Buffer.from(user.passkeySalt, "hex");
  const attempt = hashPasskey(passkey, salt);
  const ok = crypto.timingSafeEqual(Buffer.from(attempt, "hex"), Buffer.from(user.passkeyHash, "hex"));
  if (!ok) throw Object.assign(new Error("Invalid username or passkey."), { status: 401 });
  ensureApiKey(user);
  await user.save();
  const session = await createSession(user, label);
  return { user: publicUser(user), ...session };
}

async function createSession(user, label = "web") {
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

export async function rotateApiKey(userId) {
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  user.apiKey = `ntk_${crypto.randomBytes(24).toString("base64url")}`;
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
        description: "Get started with live transcription and basic AI summaries.",
        features: ["Live meeting transcription", "AI summary", "5 meetings / month", "Chrome extension"],
        maxMeetingsPerMonth: 5,
        isActive: true,
        sortOrder: 0
      },
      {
        name: "Pro",
        slug: "pro",
        priceMonthly: 12,
        description: "Unlimited notes, richer AI insights, and priority support.",
        features: ["Unlimited meetings", "Detailed AI analysis", "Action items & chat", "Export PDF / MD / TXT", "Favourites & archive"],
        maxMeetingsPerMonth: 9999,
        isActive: true,
        sortOrder: 1
      },
      {
        name: "Team",
        slug: "team",
        priceMonthly: 29,
        description: "For teams that need shared workspaces and admin controls.",
        features: ["Everything in Pro", "Team seats", "Admin dashboard", "Priority support"],
        maxMeetingsPerMonth: 9999,
        isActive: true,
        sortOrder: 2
      }
    ]);
    console.log("[seed] Default plans created (free, pro, team)");
  }

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
      planId: freePlan?._id || null,
      planSlug: "team",
      apiKey: `ntk_${crypto.randomBytes(24).toString("base64url")}`
    });
    console.log("[seed] Admin user created — username: admin / passkey: admin123");
  }

  await getSiteSettings();
}
