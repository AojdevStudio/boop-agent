import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { validateImageHeader, MAX_IMAGE_BYTES, type ImageMediaType } from "./images/mime.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

export async function sendImessage(toNumber: string, text: string): Promise<void> {
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending");
    return;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    return;
  }
  const plain = stripMarkdown(text);
  for (const part of chunk(plain)) {
    const res = await fetch(`${API_BASE}/send-message`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, content: part, from_number: from }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[sendblue] send failed ${res.status}: ${body}`);
      if (body.includes("missing required parameter") && body.includes("from_number")) {
        console.error(
          `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
        );
      } else if (body.includes("Cannot send messages to self")) {
        console.error(
          `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
        );
      } else if (body.includes("This phone number is not defined")) {
        console.error(
          `[sendblue] → Sendblue doesn't recognize from_number=${from}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
        );
      }
    } else {
      console.log(`[sendblue] → sent ${part.length} chars to ${toNumber}`);
    }
  }
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

type SendblueInbound = {
  content?: unknown;
  from_number?: unknown;
  is_outbound?: unknown;
  message_handle?: unknown;
  date_sent?: unknown;
  media_url?: unknown; // single image (legacy)
  media_urls?: unknown; // array of images (current)
};

async function processInboundMessage(raw: SendblueInbound, source: "webhook" | "poll"): Promise<"processed" | "skipped" | "deduped"> {
  const content = typeof raw.content === "string" ? raw.content : "";
  const from_number = typeof raw.from_number === "string" ? raw.from_number : "";
  const message_handle = typeof raw.message_handle === "string" ? raw.message_handle : "";
  const rawUrls: string[] = [];
  if (Array.isArray(raw.media_urls)) {
    for (const u of raw.media_urls) {
      if (typeof u === "string" && u.length > 0) rawUrls.push(u);
    }
  } else if (typeof raw.media_url === "string" && raw.media_url.length > 0) {
    rawUrls.push(raw.media_url);
  }
  if (raw.is_outbound || !from_number || (!content && rawUrls.length === 0)) {
    return "skipped";
  }

  if (message_handle) {
    const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
      handle: message_handle,
    });
    if (!claimed) return "deduped";
  }

  const ingestResults = await Promise.all(rawUrls.map(ingestSendblueImage));
  const ingested: IngestedImage[] = [];
  const ingestErrors: string[] = [];
  for (const r of ingestResults) {
    if (r.ok) ingested.push(r.image);
    else ingestErrors.push(r.reason);
  }

  const conversationId = `sms:${from_number}`;
  const turnTag = Math.random().toString(36).slice(2, 8);
  const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
  console.log(`[turn ${turnTag}] ← ${from_number} via ${source}: ${JSON.stringify(preview)}`);
  const start = Date.now();

  broadcast("message_in", { conversationId, content, from_number, handle: message_handle });

  const stopTyping = startTypingLoop(from_number);
  try {
    const reply = await handleUserMessage({
      conversationId,
      content,
      turnTag,
      images: ingested,
      mediaError: ingestErrors.length > 0 ? ingestErrors.join("; ") : undefined,
      onThinking: (t) => broadcast("thinking", { conversationId, t }),
    });
    if (reply) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
      console.log(
        `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
      );
      await sendImessage(from_number, reply);
      await convex.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: reply,
      });
    } else {
      console.log(`[turn ${turnTag}] → (no reply)`);
    }
  } catch (err) {
    console.error(`[turn ${turnTag}] handler error`, err);
  } finally {
    stopTyping();
  }
  return "processed";
}

export function startSendbluePoller(): void {
  const h = headers();
  if (!h) {
    console.warn("[sendblue-poll] missing credentials — disabled");
    return;
  }
  if (process.env.SENDBLUE_POLL_INBOUND === "false") {
    console.log("[sendblue-poll] disabled by SENDBLUE_POLL_INBOUND=false");
    return;
  }

  const intervalMs = Number(process.env.SENDBLUE_POLL_INTERVAL_MS ?? 5000);
  const lookbackMinutes = Number(process.env.SENDBLUE_POLL_LOOKBACK_MINUTES ?? 10);
  let cursorMs = Date.now() - lookbackMinutes * 60_000;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const qs = new URLSearchParams({
        is_outbound: "false",
        limit: "20",
        order_direction: "asc",
        created_at_gte: new Date(cursorMs - 30_000).toISOString(),
      });
      const res = await fetch(`https://api.sendblue.com/api/v2/messages?${qs}`, { headers: h });
      if (!res.ok) {
        console.warn(`[sendblue-poll] list failed ${res.status}: ${await res.text().catch(() => "")}`);
        return;
      }
      const payload = (await res.json()) as { data?: SendblueInbound[] };
      for (const msg of payload.data ?? []) {
        const sent = typeof msg.date_sent === "string" ? Date.parse(msg.date_sent) : NaN;
        if (Number.isFinite(sent)) cursorMs = Math.max(cursorMs, sent + 1);
        await processInboundMessage(msg, "poll");
      }
    } catch (err) {
      console.warn("[sendblue-poll] tick failed", err);
    } finally {
      running = false;
    }
  };

  console.log(`[sendblue-poll] enabled every ${intervalMs}ms (lookback ${lookbackMinutes}m)`);
  void tick();
  setInterval(tick, intervalMs);
}

type IngestedImage = { storageId: string; mediaType: ImageMediaType };

export async function ingestSendblueImage(
  url: string,
): Promise<{ ok: true; image: IngestedImage } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `download failed: HTTP ${res.status}` };
  }
  const lenHeader = res.headers.get("content-length");
  const contentLength = lenHeader ? Number(lenHeader) : undefined;
  const check = validateImageHeader({
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength,
  });
  if (!check.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: check.reason };
  }
  // Stream the body so we can abort early when the running total exceeds
  // MAX_IMAGE_BYTES — content-length is often absent on CDN/redirect
  // responses, and `await res.arrayBuffer()` would otherwise buffer the
  // entire payload before any cap check fires.
  let buf: ArrayBuffer;
  try {
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "download failed: no body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: `image too large: >${MAX_IMAGE_BYTES} bytes`,
        };
      }
      chunks.push(value);
    }
    buf = new ArrayBuffer(total);
    const view = new Uint8Array(buf);
    let offset = 0;
    for (const c of chunks) {
      view.set(c, offset);
      offset += c.byteLength;
    }
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }

  try {
    const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": check.mediaType },
      body: buf,
      signal: AbortSignal.timeout(10_000),
    });
    if (!upload.ok) {
      return { ok: false, reason: `upload failed: HTTP ${upload.status}` };
    }
    const { storageId } = (await upload.json()) as { storageId: string };
    return { ok: true, image: { storageId, mediaType: check.mediaType } };
  } catch (err) {
    return { ok: false, reason: `upload failed: ${String(err)}` };
  }
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", (req, res) => {
    void processInboundMessage(req.body ?? {}, "webhook").catch((err) =>
      console.error("[sendblue-webhook] processing failed", err),
    );
    // Acknowledge immediately so Sendblue doesn't time out long Claude turns.
    // Deduplication by message_handle keeps any retry/poller overlap safe.
    res.json({ ok: true });
  });

  return router;
}
