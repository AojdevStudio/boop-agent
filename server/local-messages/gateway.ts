import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_IMSG = join(homedir(), "Projects/imsg/bin/imsg");
const DEFAULT_DB = join(homedir(), "Library/Messages/chat.db");
const RESOLVE_CONTACT = join(homedir(), ".claude/skills/imsg/Tools/resolve-contact.ts");

export interface LocalMessagesStatus {
  ok: boolean;
  imsgPath: string;
  binaryOk: boolean;
  dbPath: string;
  dbReadable: boolean;
  errors: string[];
}

export interface LocalChat {
  id: number;
  name?: string;
  identifier?: string;
  guid?: string;
  service?: string;
  last_message_at?: string;
  participants?: string[];
  is_group?: boolean;
}

export interface LocalMessage {
  id?: number;
  chat_id?: number;
  guid?: string;
  sender?: string;
  is_from_me?: boolean;
  text?: string;
  created_at?: string;
  chat_identifier?: string;
  chat_guid?: string;
  chat_name?: string;
  participants?: string[];
  is_group?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function imsgPath(): string {
  return process.env.LOCAL_MESSAGES_IMSG_PATH || DEFAULT_IMSG;
}

function messagesDbPath(): string {
  return process.env.LOCAL_MESSAGES_DB_PATH || DEFAULT_DB;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function runCommand(command: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function parseNdjson<T>(stdout: string): T[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function safeLimit(input: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(input)) return fallback;
  return Math.max(1, Math.min(Math.floor(input!), max));
}

export async function checkLocalMessagesStatus(): Promise<LocalMessagesStatus> {
  const path = expandHome(imsgPath());
  const dbPath = expandHome(messagesDbPath());
  const errors: string[] = [];
  let binaryOk = false;
  try {
    binaryOk = existsSync(path) && statSync(path).isFile();
    if (!binaryOk) errors.push(`imsg binary missing at ${path}`);
  } catch (err) {
    errors.push(`imsg binary check failed: ${String(err)}`);
  }

  let dbReadable = false;
  try {
    const res = await runCommand("sqlite3", [dbPath, "pragma quick_check;"], 10_000);
    dbReadable = res.code === 0 && res.stdout.includes("ok");
    if (!dbReadable) {
      errors.push(
        `Messages database unreadable at ${dbPath}. Grant Full Disk Access to the terminal/process running Boop. ${res.stderr || res.stdout}`.trim(),
      );
    }
  } catch (err) {
    errors.push(`Messages database check failed: ${String(err)}`);
  }

  return { ok: binaryOk && dbReadable, imsgPath: path, binaryOk, dbPath, dbReadable, errors };
}

let cachedStatus: { at: number; value: LocalMessagesStatus } | null = null;
export async function cachedPreflight(): Promise<LocalMessagesStatus> {
  if (cachedStatus) return cachedStatus.value;
  const value = await checkLocalMessagesStatus();
  cachedStatus = { at: Date.now(), value };
  return value;
}

async function requireReady(): Promise<void> {
  const status = await cachedPreflight();
  if (!status.ok) throw new Error(status.errors.join("\n") || "Local Messages preflight failed");
}

export async function listChats(limit = 20): Promise<LocalChat[]> {
  await requireReady();
  const res = await runCommand(imsgPath(), ["chats", "--limit", String(safeLimit(limit, 20, 100)), "--json"]);
  if (res.code !== 0) throw new Error(res.stderr || res.stdout || "imsg chats failed");
  return parseNdjson<LocalChat>(res.stdout).filter((c) => !c.is_group);
}

export async function readChatHistory(chatId: number, limit = 50): Promise<LocalMessage[]> {
  await requireReady();
  const capped = safeLimit(limit, 50, 200);
  const res = await runCommand(imsgPath(), ["history", "--chat-id", String(chatId), "--limit", String(capped), "--json"]);
  if (res.code !== 0) throw new Error(res.stderr || res.stdout || "imsg history failed");
  return parseNdjson<LocalMessage>(res.stdout).filter((m) => !m.is_group);
}

export async function watchChat(chatId: number, timeoutSeconds: number): Promise<LocalMessage[]> {
  await requireReady();
  const seconds = Math.max(1, Math.min(Math.floor(timeoutSeconds), 30 * 60));
  const res = await runCommand(imsgPath(), ["watch", "--chat-id", String(chatId), "--json"], seconds * 1000);
  // imsg watch is killed by timeout; keep any messages emitted before shutdown.
  if (res.code !== 0 && !res.stdout.trim()) throw new Error(res.stderr || "imsg watch failed");
  return parseNdjson<LocalMessage>(res.stdout).filter((m) => !m.is_group);
}

export interface RecipientCandidate {
  chatId: number;
  label: string;
  identifier?: string;
  service?: string;
  lastMessageAt?: string;
}

export async function resolveRecipient(query: string, limit = 10): Promise<RecipientCandidate[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const chats = await listChats(100);
  const hits = chats.filter((c) => {
    const hay = `${c.name ?? ""} ${c.identifier ?? ""} ${(c.participants ?? []).join(" ")}`.toLowerCase();
    return hay.includes(q);
  });
  return hits.slice(0, safeLimit(limit, 10, 25)).map((c) => ({
    chatId: c.id,
    label: c.name || c.identifier || `chat ${c.id}`,
    identifier: c.identifier,
    service: c.service,
    lastMessageAt: c.last_message_at,
  }));
}

export async function resolveHandles(handles: string[]): Promise<Array<{ handle: string; name: string | null; organization: string | null; source: string }>> {
  if (!handles.length || !existsSync(RESOLVE_CONTACT)) return [];
  const res = await runCommand("bun", ["run", RESOLVE_CONTACT, ...handles, "--json"], 10_000);
  if (res.code !== 0) throw new Error(res.stderr || res.stdout || "contact resolution failed");
  return parseNdjson(res.stdout);
}

export async function sendText(opts: { to?: string; chatId?: number; text: string }): Promise<string> {
  await requireReady();
  const args = ["send"];
  if (opts.chatId !== undefined) args.push("--chat-id", String(opts.chatId));
  if (opts.to) args.push("--to", opts.to);
  args.push("--text", opts.text, "--service", "auto", "--region", "US", "--json");
  const res = await runCommand(imsgPath(), args, 30_000);
  if (res.code !== 0) throw new Error(res.stderr || res.stdout || "imsg send failed");
  return res.stdout.trim() || "sent";
}

export function localMessageMetadata(input: unknown): string {
  return JSON.stringify(input, (_key, value) => {
    if (_key === "text" || _key === "messages" || _key === "content") return "[redacted]";
    return value;
  }).slice(0, 2000);
}
