import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { attachmentsHash, textHash, tokenHash } from "../local-messages/approval.js";
import {
  cachedPreflight,
  checkLocalMessagesStatus,
  listChats,
  localMessageMetadata,
  readChatHistory,
  resolveHandles,
  resolveRecipient,
  sendText,
  watchChat,
} from "../local-messages/gateway.js";
import type { IntegrationModule, IntegrationContext } from "./registry.js";

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

async function emitMetadata(conversationId: string | undefined, eventType: string, data: unknown) {
  if (!conversationId) return;
  await convex.mutation(api.memoryEvents.emit, {
    eventType,
    conversationId,
    data: localMessageMetadata(data),
  });
}

async function createServer(ctx: IntegrationContext): Promise<McpSdkServerConfigWithInstance> {
  void cachedPreflight().catch((err) => console.warn("[local-messages] preflight failed", err));
  return createSdkMcpServer({
    name: "local-messages",
    version: "0.1.0",
    tools: [
      tool(
        "check_local_messages_status",
        "Check whether the host Mac can use Local Messages: imsg binary exists and ~/Library/Messages/chat.db is readable. Does not read message content.",
        {},
        async () => json(await checkLocalMessagesStatus()),
      ),
      tool(
        "list_chats",
        "List recent 1:1 local Messages chats. Returns metadata only: chat ids, labels, identifiers, service, and last message timestamp. Group chats are excluded in v1.",
        { limit: z.number().int().min(1).max(100).optional().default(20) },
        async ({ limit }) => {
          const chats = await listChats(limit);
          await emitMetadata(ctx.conversationId, "local_messages.list_chats", { limit, count: chats.length });
          return json({ chats });
        },
      ),
      tool(
        "resolve_recipient",
        "Resolve a person/name/handle into Recipient Candidates for 1:1 Local Messages chats. If multiple candidates are returned, ask the user to choose; never guess.",
        {
          query: z.string(),
          limit: z.number().int().min(1).max(25).optional().default(10),
        },
        async ({ query, limit }) => {
          const candidates = await resolveRecipient(query, limit);
          await emitMetadata(ctx.conversationId, "local_messages.resolve_recipient", {
            query,
            count: candidates.length,
          });
          return json({ candidates });
        },
      ),
      tool(
        "resolve_contact_handles",
        "Resolve phone/email handles to contact names using the local macOS Contacts database. Returns labels only; does not read messages.",
        { handles: z.array(z.string()).min(1).max(25) },
        async ({ handles }) => json({ results: await resolveHandles(handles) }),
      ),
      tool(
        "read_chat_history",
        "Read a targeted 1:1 local Messages chat history by chat id. Defaults to 50 messages; v1 hard max is 200. Use only for user-initiated targeted reads.",
        {
          chatId: z.number().int().positive(),
          limit: z.number().int().min(1).max(200).optional().default(50),
        },
        async ({ chatId, limit }) => {
          const messages = await readChatHistory(chatId, limit);
          await emitMetadata(ctx.conversationId, "local_messages.read_chat_history", {
            chatId,
            limit,
            count: messages.length,
          });
          return json({ chatId, count: messages.length, messages });
        },
      ),
      tool(
        "watch_chat_once",
        "Broad Read: watch one selected 1:1 local Messages chat for new messages for a bounded timeout, then stop. You MUST only call this after the user explicitly confirmed the watch.",
        {
          chatId: z.number().int().positive(),
          timeoutSeconds: z.number().int().min(1).max(1800),
          confirmed: z.boolean().describe("Must be true only after explicit user confirmation."),
        },
        async ({ chatId, timeoutSeconds, confirmed }) => {
          if (!confirmed) return text("Denied: One-Shot Watch requires explicit user confirmation.");
          const messages = await watchChat(chatId, timeoutSeconds);
          await emitMetadata(ctx.conversationId, "local_messages.watch_chat_once", {
            chatId,
            timeoutSeconds,
            count: messages.length,
          });
          return json({ chatId, count: messages.length, messages });
        },
      ),
      tool(
        "send_approved_text",
        "Send an approved text-only Local Messages draft. This tool enforces the Approval Gate immediately before sending. It refuses unless draft id, approval token, recipient/chat id, exact text hash, attachment hash, and expiry all match the approved draft.",
        {
          draftId: z.string(),
          approvalToken: z.string(),
          to: z.string().optional(),
          chatId: z.number().int().positive().optional(),
          text: z.string(),
        },
        async ({ draftId, approvalToken, to, chatId, text: body }) => {
          if (!to && chatId === undefined) return text("Denied: provide either to or chatId.");
          const recipient = chatId !== undefined ? `chat:${chatId}` : `to:${to}`;
          const verification = await convex.query(api.drafts.verifyLocalMessageApproval, {
            draftId,
            tokenHash: tokenHash(approvalToken),
            recipient,
            textHash: textHash(body),
            attachmentsHash: attachmentsHash([]),
            now: Date.now(),
          });
          if (!verification.ok) return text(`Denied: ${verification.reason}`);
          const result = await sendText({ to, chatId, text: body });
          await convex.mutation(api.drafts.setStatus, { draftId, status: "sent" });
          await emitMetadata(ctx.conversationId, "local_messages.send_approved_text", {
            draftId,
            recipient,
            textLength: body.length,
            sent: true,
          });
          return json({ ok: true, result });
        },
      ),
    ],
  });
}

export const localMessagesIntegration: IntegrationModule = {
  name: "local-messages",
  description: "Host-Mac-only Local Messages Integration for user-initiated 1:1 Messages.app reads, bounded watches, and token-approved text sends.",
  createServer,
};
