import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("rejected"),
  v.literal("expired"),
);

export const create = mutation({
  args: {
    draftId: v.string(),
    conversationId: v.string(),
    kind: v.string(),
    summary: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("drafts", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const get = query({
  args: { draftId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("drafts")
      .withIndex("by_draft_id", (q) => q.eq("draftId", args.draftId))
      .unique();
  },
});

export const pendingByConversation = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("drafts")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending"),
      )
      .order("desc")
      .take(25);
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db.query("drafts").order("desc").take(args.limit ?? 50);
  },
});

export const setStatus = mutation({
  args: { draftId: v.string(), status: statusV },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query("drafts")
      .withIndex("by_draft_id", (q) => q.eq("draftId", args.draftId))
      .unique();
    if (!draft) return null;
    await ctx.db.patch(draft._id, { status: args.status, decidedAt: Date.now() });
    return draft;
  },
});

export const approveLocalMessage = mutation({
  args: {
    draftId: v.string(),
    tokenHash: v.string(),
    recipient: v.string(),
    textHash: v.string(),
    attachmentsHash: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query("drafts")
      .withIndex("by_draft_id", (q) => q.eq("draftId", args.draftId))
      .unique();
    if (!draft || draft.status !== "pending" || draft.kind !== "local-messages.text") {
      return null;
    }
    await ctx.db.patch(draft._id, {
      approvalTokenHash: args.tokenHash,
      approvalRecipient: args.recipient,
      approvalTextHash: args.textHash,
      approvalAttachmentsHash: args.attachmentsHash,
      approvalExpiresAt: args.expiresAt,
      approvalCreatedAt: Date.now(),
    });
    return draft._id;
  },
});

export const verifyLocalMessageApproval = query({
  args: {
    draftId: v.string(),
    tokenHash: v.string(),
    recipient: v.string(),
    textHash: v.string(),
    attachmentsHash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query("drafts")
      .withIndex("by_draft_id", (q) => q.eq("draftId", args.draftId))
      .unique();
    if (!draft) return { ok: false, reason: "draft not found" };
    if (draft.status !== "pending") return { ok: false, reason: `draft is ${draft.status}` };
    if (draft.kind !== "local-messages.text") return { ok: false, reason: "draft is not a Local Messages text draft" };
    if (!draft.approvalTokenHash || !draft.approvalExpiresAt) return { ok: false, reason: "draft is not approved" };
    if (draft.approvalExpiresAt < args.now) return { ok: false, reason: "approval expired" };
    if (draft.approvalTokenHash !== args.tokenHash) return { ok: false, reason: "approval token mismatch" };
    if (draft.approvalRecipient !== args.recipient) return { ok: false, reason: "recipient mismatch" };
    if (draft.approvalTextHash !== args.textHash) return { ok: false, reason: "message text mismatch" };
    if (draft.approvalAttachmentsHash !== args.attachmentsHash) return { ok: false, reason: "attachment mismatch" };
    return { ok: true, reason: "approved" };
  },
});
