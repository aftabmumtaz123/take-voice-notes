/**
 * Auth: username + passkey, session cookies for web, API keys for the extension.
 */
import crypto from "node:crypto";
import mongoose from "mongoose";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

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
  apiKey: { type: String, unique: true, sparse: true, index: true },
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
    apiKey: user.apiKey || null,
    createdAt: user.createdAt
  };
}

export async function registerUser({ username, passkey, displayName = "" }) {
  const err = validateCredentials(username, passkey);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const u = normalizeUsername(username);
  if (await User.findOne({ username: u })) {
    throw Object.assign(new Error("Username is already taken."), { status: 409 });
  }
  const salt = crypto.randomBytes(16);
  const user = await User.create({
    username: u,
    passkeyHash: hashPasskey(passkey, salt),
    passkeySalt: salt.toString("hex"),
    displayName: String(displayName || u).slice(0, 80),
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
    apiKey: user.apiKey
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
    return user ? publicUser(user) : null;
  }

  const user = await User.findOne({
    "sessions.tokenHash": hashToken(token),
    "sessions.expiresAt": { $gt: new Date() }
  });
  return user ? publicUser(user) : null;
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
