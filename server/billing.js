import mongoose from 'mongoose';
import { Plan, User } from './auth.js';
import crypto from 'node:crypto';

const workspaceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null, index: true },
  seatLimit: { type: Number, default: 5, min: 1, max: 500 },
  status: { type: String, enum: ['active', 'suspended', 'archived'], default: 'active', index: true }
}, { timestamps: true });
workspaceSchema.index({ ownerId: 1, status: 1 });
export const Workspace = mongoose.models.Workspace || mongoose.model('Workspace', workspaceSchema);

const workspaceMemberSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
  status: { type: String, enum: ['active', 'removed'], default: 'active' },
  joinedAt: { type: Date, default: Date.now }
}, { timestamps: true });
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
export const WorkspaceMember = mongoose.models.WorkspaceMember || mongoose.model('WorkspaceMember', workspaceMemberSchema);

const workspaceInvitationSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 200, index: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted', 'expired', 'revoked'], default: 'pending', index: true }
}, { timestamps: true });
export const WorkspaceInvitation = mongoose.models.WorkspaceInvitation || mongoose.model('WorkspaceInvitation', workspaceInvitationSchema);

export function generateWorkspaceInviteToken() { return crypto.randomBytes(32).toString('base64url'); }
export function hashWorkspaceInviteToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

export async function getUserWorkspaces(userId) {
  const memberships = await WorkspaceMember.find({ userId, status: 'active' }).populate('workspaceId').sort({ createdAt: 1 }).lean();
  return memberships.map(m => ({ ...m.workspaceId, role: m.role, membershipId: m._id })).filter(Boolean);
}
export async function getWorkspaceForUser(userId, workspaceId = null) {
  const filter = { userId, status: 'active' };
  if (workspaceId && mongoose.isValidObjectId(workspaceId)) filter.workspaceId = workspaceId;
  const membership = await WorkspaceMember.findOne(filter).populate('workspaceId').lean();
  if (!membership?.workspaceId) return null;
  return { ...membership.workspaceId, role: membership.role, membershipId: membership._id };
}
export async function ensureTeamWorkspace({ userId, subscriptionId, name = 'My Team', seatLimit = 5 }) {
  let workspace = await Workspace.findOne({ ownerId: userId, status: { $ne: 'archived' } }).sort({ createdAt: 1 });
  if (!workspace) workspace = await Workspace.create({ name: String(name || 'My Team').trim().slice(0,100) || 'My Team', ownerId: userId, subscriptionId, seatLimit: Math.max(1, Math.min(500, Number(seatLimit) || 5)) });
  else { workspace.subscriptionId = subscriptionId; workspace.seatLimit = Math.max(workspace.seatLimit || 5, Number(seatLimit) || 5); workspace.status = 'active'; await workspace.save(); }
  await WorkspaceMember.updateOne({ workspaceId: workspace._id, userId }, { $setOnInsert: { role: 'owner', status: 'active', joinedAt: new Date() } }, { upsert: true });
  return workspace.toObject();
}

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  planSlug: { type: String, required: true, index: true },
  status: { type: String, enum: ['trialing', 'active', 'past_due', 'cancelled', 'expired'], default: 'active', index: true },
  billingInterval: { type: String, enum: ['month', 'year'], default: 'month' },
  startedAt: { type: Date, default: Date.now },
  currentPeriodStart: { type: Date, default: Date.now },
  currentPeriodEnd: { type: Date, default: null },
  cancelAtPeriodEnd: { type: Boolean, default: false },
  paymentMethod: { type: String, default: 'manual' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: '', maxlength: 120 },
  cancellationFeedback: { type: String, default: '', maxlength: 1000 }
}, { timestamps: true });
subscriptionSchema.index({ userId: 1, status: 1, currentPeriodEnd: -1 });
export const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);

const upgradeRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requestedPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  requestedPlanSlug: { type: String, required: true },
  billingInterval: { type: String, enum: ['month', 'year'], default: 'month' },
  amount: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  paymentMethod: { type: String, default: 'manual' },
  note: { type: String, default: '', maxlength: 1000 },
  workspaceName: { type: String, default: '', maxlength: 100 },
  seats: { type: Number, default: 5, min: 1, max: 500 },
  status: { type: String, enum: ['pending', 'processing', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: '', maxlength: 500 },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null }
}, { timestamps: true });
upgradeRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });
export const UpgradeRequest = mongoose.models.UpgradeRequest || mongoose.model('UpgradeRequest', upgradeRequestSchema);

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null, index: true },
  upgradeRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'UpgradeRequest', default: null },
  amount: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  method: { type: String, default: 'manual' },
  status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded', 'cancelled'], default: 'pending', index: true },
  reference: { type: String, default: '', maxlength: 200 },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  verifiedAt: { type: Date, default: null },
  paidAt: { type: Date, default: null }
}, { timestamps: true });
paymentSchema.index({ userId: 1, createdAt: -1 });
export const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

function addPeriod(start, interval) {
  const end = new Date(start);
  if (interval === 'year') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

export async function getUserSubscription(userId) {
  if (!userId) return null;
  const sub = await Subscription.findOne({ userId, status: { $in: ['trialing', 'active'] } })
    .sort({ currentPeriodEnd: -1, createdAt: -1 })
    .populate('planId')
    .lean();
  if (!sub) return null;
  if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) <= new Date()) {
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: 'expired' } }).catch(() => {});
    const free = await Plan.findOne({ slug: 'free', isActive: true }).lean().catch(() => null);
    if (free) await User.findByIdAndUpdate(userId, { $set: { planId: free._id, planSlug: 'free' } }).catch(() => {});
    if (sub.planSlug === 'team') await Workspace.updateMany({ subscriptionId: sub._id, status: 'active' }, { $set: { status: 'archived' } }).catch(() => {});
    return null;
  }
  return sub;
}

export async function getEffectivePlan(userLike) {
  const userId = userLike?.id || userLike?._id;
  const subscription = await getUserSubscription(userId).catch(() => null);
  if (subscription?.planId) return { plan: subscription.planId, subscription };
  const slug = String(userLike?.planSlug || 'free').toLowerCase();
  const plan = await Plan.findOne({ slug }).lean().catch(() => null)
    || await Plan.findOne({ slug: 'free' }).lean().catch(() => null);
  return { plan, subscription: null };
}

export async function getPendingUpgradeRequest(userId) {
  return UpgradeRequest.findOne({ userId, status: 'pending' }).sort({ createdAt: -1 }).populate('requestedPlanId').lean();
}

export async function createUpgradeRequest({ userId, planSlug = 'pro', billingInterval = 'month', paymentMethod = 'manual', note = '', workspaceName = '', seats = 5 }) {
  const plan = await Plan.findOne({ slug: String(planSlug).toLowerCase(), isActive: true }).lean();
  if (!plan) throw new Error('Selected plan is not available.');
  if (plan.slug === 'free') throw new Error('You are already eligible for the Free plan.');
  const current = await getEffectivePlan({ id: userId, planSlug: 'free' });
  if (current.plan?.slug === plan.slug && current.subscription?.status === 'active') throw new Error(`You already have an active ${plan.name} subscription.`);
  const existing = await getPendingUpgradeRequest(userId);
  if (existing) return { request: existing, duplicate: true };
  const interval = billingInterval === 'year' ? 'year' : 'month';
  const amount = interval === 'year' ? Number(plan.priceAnnual || 0) : Number(plan.priceMonthly || 0);
  const request = await UpgradeRequest.create({
    userId, requestedPlanId: plan._id, requestedPlanSlug: plan.slug,
    billingInterval: interval, amount, currency: plan.currency || 'USD',
    paymentMethod: String(paymentMethod || 'manual').slice(0, 80),
    note: String(note || '').slice(0, 1000),
    workspaceName: String(workspaceName || '').trim().slice(0, 100),
    seats: Math.max(1, Math.min(500, Number(seats) || 5))
  });
  return { request: request.toObject(), duplicate: false };
}

export async function activateSubscription({ userId, planId, billingInterval = 'month', paymentMethod = 'manual', adminId = null, upgradeRequestId = null, amount = null, currency = null, reference = '', workspaceName = '', seats = 5 }) {
  const plan = await Plan.findById(planId).lean();
  if (!plan || !plan.isActive) throw new Error('Plan is not available.');
  const now = new Date();
  const interval = billingInterval === 'year' ? 'year' : 'month';
  const periodEnd = plan.slug === 'free' ? null : addPeriod(now, interval);

  await Subscription.updateMany(
    { userId, status: { $in: ['trialing', 'active'] } },
    { $set: { status: 'cancelled', cancelledAt: now } }
  );

  const subscription = await Subscription.create({
    userId, planId: plan._id, planSlug: plan.slug, status: 'active', billingInterval: interval,
    startedAt: now, currentPeriodStart: now, currentPeriodEnd: periodEnd,
    paymentMethod: String(paymentMethod || 'manual').slice(0, 80), createdBy: adminId || null
  });

  await User.findByIdAndUpdate(userId, { $set: { planId: plan._id, planSlug: plan.slug } });

  if (plan.slug === 'team') {
    await ensureTeamWorkspace({ userId, subscriptionId: subscription._id, name: workspaceName || 'My Team', seatLimit: seats });
  }

  if (plan.slug !== 'free' && upgradeRequestId) {
    await UpgradeRequest.updateOne(
      { _id: upgradeRequestId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'approved', reviewedBy: adminId || null, reviewedAt: now, subscriptionId: subscription._id } }
    );
    await Payment.create({
      userId, subscriptionId: subscription._id, upgradeRequestId,
      amount: amount == null ? (interval === 'year' ? Number(plan.priceAnnual || 0) : Number(plan.priceMonthly || 0)) : Number(amount || 0),
      currency: currency || plan.currency || 'USD', method: String(paymentMethod || 'manual').slice(0, 80),
      status: 'paid', reference: String(reference || '').slice(0, 200), verifiedBy: adminId || null,
      verifiedAt: now, paidAt: now
    });
  }
  return subscription.toObject();
}

export async function rejectUpgradeRequest(requestId, adminId, reason = '') {
  return UpgradeRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { $set: { status: 'rejected', reviewedBy: adminId, reviewedAt: new Date(), rejectionReason: String(reason || '').slice(0, 500) } },
    { returnDocument: 'after' }
  ).lean();
}

export async function scheduleSubscriptionCancellation(userId, { reason = '', feedback = '' } = {}) {
  const sub = await Subscription.findOne({ userId, status: { $in: ['trialing', 'active'] } }).sort({ currentPeriodEnd: -1, createdAt: -1 });
  if (!sub) throw new Error('No active paid subscription was found.');
  if (!sub.currentPeriodEnd) throw new Error('This subscription has no scheduled billing period to cancel.');
  sub.cancelAtPeriodEnd = true;
  sub.cancellationReason = String(reason || '').slice(0, 120);
  sub.cancellationFeedback = String(feedback || '').slice(0, 1000);
  await sub.save();
  return sub.toObject();
}

export async function undoSubscriptionCancellation(userId) {
  const sub = await Subscription.findOne({ userId, status: { $in: ['trialing', 'active'] } }).sort({ currentPeriodEnd: -1, createdAt: -1 });
  if (!sub) throw new Error('No active subscription was found.');
  if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) <= new Date()) throw new Error('This subscription period has already ended.');
  sub.cancelAtPeriodEnd = false;
  sub.cancellationReason = '';
  sub.cancellationFeedback = '';
  sub.cancelledAt = null;
  await sub.save();
  return sub.toObject();
}

// Kept for existing admin tooling: admin cancellation is immediate, while the user-facing flow is scheduled.
export async function cancelUserSubscription(userId, adminId = null) {
  const now = new Date();
  const sub = await Subscription.findOne({ userId, status: { $in: ['trialing', 'active'] } }).sort({ createdAt: -1 });
  if (sub) {
    sub.status = 'cancelled'; sub.cancelledAt = now; sub.cancelAtPeriodEnd = false;
    await sub.save();
  }
  const free = await Plan.findOne({ slug: 'free', isActive: true }).lean();
  if (free) {
    await User.findByIdAndUpdate(userId, { $set: { planId: free._id, planSlug: 'free' } });
    await Subscription.create({ userId, planId: free._id, planSlug: 'free', status: 'active', billingInterval: 'month', startedAt: now, currentPeriodStart: now, currentPeriodEnd: null, paymentMethod: 'manual', createdBy: adminId || null });
  }
  return sub?.toObject() || null;
}
