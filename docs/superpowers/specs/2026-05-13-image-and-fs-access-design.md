# Image viewing and sandboxed filesystem access — Design

**Date:** 2026-05-13
**Status:** Proposed
**Topic:** Add the ability for Boop to view images sent over iMessage, and grant agents read/write access to a sandboxed filesystem workspace.

---

## 1. Goals

1. **Images:** Let Boop "see" images the user texts it. The dispatcher (interaction agent) sees image content directly. The dispatcher can pass images to spawned execution agents when relevant. Image content also becomes memory.
2. **Filesystem:** Give agents read/write access to a single configurable workspace directory on the host. Dispatcher gets read-only (Read / LS / Glob). Execution agents get full read/write plus Bash, all rooted at the same workspace.

Both features are gated by configuration. Defaults preserve current behavior.

## 2. Non-goals

- Sending images outbound from Boop. Receive-only.
- Image generation. Receive and view only.
- Filesystem access outside the workspace directory.
- Per-user workspace partitioning. Single-user agent; single workspace.
- Multi-modal documents (PDF, video) — images only.

## 3. Architecture overview

```
iMessage (Sendblue) ── webhook ──► server/sendblue.ts
                                       │
                                       ▼ download image bytes
                                  Convex file storage
                                       │
                                       ▼ storageId on message
                                  Interaction Agent
                                  (sees text + image)
                                       │
                ┌──────────────────────┼─────────────────────┐
                ▼                      ▼                     ▼
         spawn_agent w/         memory extraction      reply in chat
         imageRefs[]            (Haiku describes
           │                     image → memory)
           ▼
   Execution Agent  ── if BOOP_VPS_FILESYSTEM_ACCESS=sandbox ──
                    Read/Write/Edit/Bash with cwd=workspace
                    + canUseTool guard rejects paths
                    outside BOOP_WORKSPACE_DIR
```

The image and filesystem subsystems are independent: each can ship without the other and is configured separately.

## 4. Configuration

| Env var | Values | Default | Meaning |
|---|---|---|---|
| `BOOP_VPS_FILESYSTEM_ACCESS` | `off` / `sandbox` / `full` | `off` (unset) | Filesystem capability tier. `full` is the existing behavior, unchanged. |
| `BOOP_WORKSPACE_DIR` | absolute path | `~/boop-workspace` | Workspace root, used when `BOOP_VPS_FILESYSTEM_ACCESS=sandbox`. |
| `BOOP_IMAGE_RETENTION_DAYS` | integer | `3` | TTL for image bytes in Convex storage. `0` disables cleanup. |

If both `sandbox` and `full` are somehow attempted, `full` wins — existing `full` deployments cannot silently downgrade.

## 5. Image pipeline

### 5.1 Ingest (`server/sendblue.ts`)

- The Sendblue webhook payload includes a media URL on MMS messages. Detect when present.
- Download bytes synchronously with:
  - 10-second timeout
  - 10MB hard cap (HEAD or partial read first; reject before downloading full bytes if `content-length` exceeds cap)
  - MIME allowlist: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- Upload bytes to Convex file storage via a new mutation. Returned `Id<"_storage">` is appended to `imageStorageIds` on the message record.
- On any failure (download error, oversize, wrong MIME, Convex upload failure), the message is still stored text-only with `mediaError: "<short reason>"`. The dispatcher sees a system note prepended to the user text: `[user sent N images but they couldn't be downloaded: <reason>]`.

### 5.2 Dispatcher consumption (`server/interaction-agent.ts`)

When building the SDK turn input, if the latest user message has `imageStorageIds`:
- Fetch bytes from Convex storage
- Base64-encode each
- Construct Anthropic SDK content blocks: `[{type:"image", source:{type:"base64", media_type, data}}, ..., {type:"text", text: userText}]`
- Replace the string prompt with the content array

System prompt update:
- The current "you have NO file access" line is split: when sandbox mode is active, it becomes "you have **read-only** access to a workspace at `$BOOP_WORKSPACE_DIR`" (see §6).
- A new line is appended whether sandbox is active or not: "When the user sends images, treat them as part of the message. You can describe them, answer questions about them, or pass them to a sub-agent via `spawn_agent`'s `imageRefs` param."

### 5.3 Propagation to execution agents (`server/execution-agent.ts`)

- The `spawn_agent` tool definition gains an optional parameter: `imageRefs: string[]` (Convex storageIds).
- The dispatcher decides which images, if any, are relevant to the spawned task and includes them.
- `spawnExecutionAgent()` resolves those storageIds to bytes and prepends image content blocks to the execution agent's task prompt.
- If a referenced storageId no longer exists, the spawn fails with a structured tool error. The dispatcher can retry without the missing image.

### 5.4 Memory extraction (`server/memory/extract.ts`)

- When a turn contains images, the existing post-turn extraction Haiku call also receives them as content blocks.
- It produces normal text memory records as before, **plus** may produce a description-style record like `"User sent a photo: <one-sentence description>"` tagged with `imageStorageIds` pointing back to the image.
- This is what makes "remember that photo I sent" searchable.
- Memory records gain an optional `imageStorageIds: Id<"_storage">[]` field.

### 5.5 Schema changes (`convex/schema.ts`)

- `messages` table:
  - `imageStorageIds?: v.array(v.id("_storage"))`
  - `mediaError?: v.string()`
- `memoryRecords` table:
  - `imageStorageIds?: v.array(v.id("_storage"))`
- A query pattern on `messages` that makes the cleanup sweep efficient — likely a `by_createdAt` index iterated in ascending order with an in-query filter for non-empty `imageStorageIds`. Finalized during implementation.

## 6. Filesystem pipeline

### 6.1 Workspace module (`server/workspace.ts`, new)

- Reads `BOOP_VPS_FILESYSTEM_ACCESS` and `BOOP_WORKSPACE_DIR`.
- Expands `~`, resolves to an absolute realpath.
- Creates the directory if missing.
- Exports:
  - `WORKSPACE_MODE: "off" | "sandbox" | "full"`
  - `WORKSPACE_ROOT: string` (absolute, canonicalized)
  - `isPathInWorkspace(p: string): boolean` — resolves the input via `path.resolve` then `realpathSync` then checks prefix-match against `WORKSPACE_ROOT`. Symlinks resolve before the check; null bytes and parent-traversal sequences are handled by `path.resolve`.
- If mode is `sandbox` and the workspace dir cannot be read/written, the module throws at import time and the server refuses to boot. No half-enabled states.

### 6.2 Execution agent (`server/execution-agent.ts`)

When `WORKSPACE_MODE === "sandbox"`:
- SDK `cwd: WORKSPACE_ROOT`
- `tools: ["Read", "Write", "Edit", "Glob", "Grep", "LS", "Bash", "WebSearch", "WebFetch", "Skill"]`
- `allowedTools` includes all of the above plus the existing `mcp__*` entries
- New SDK `canUseTool` callback:
  - For `Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`: resolve the path argument, run it through `isPathInWorkspace`, reject with a structured error message if outside. Error string: `"path outside workspace: <path> — workspace is rooted at <root>"`.
  - For `Bash`: no path guard; `cwd` constraint only. This is by design (Q7 chose `B`).

When `WORKSPACE_MODE === "full"`: unchanged from today.

When `WORKSPACE_MODE === "off"`: unchanged from today.

### 6.3 Interaction agent (`server/interaction-agent.ts`)

When `WORKSPACE_MODE === "sandbox"`:
- Add `Read`, `LS`, `Glob` to the dispatcher's `tools` and `allowedTools`
- Remove those three from the existing `disallowedTools` list (Read currently disallowed)
- SDK `cwd: WORKSPACE_ROOT`
- Same `canUseTool` path guard for the three read tools
- System prompt: the "NO file access" paragraph is rewritten to:

> You have **read-only** access to a workspace at `$BOOP_WORKSPACE_DIR`. Use `Read`, `LS`, `Glob` for quick lookups. For anything that needs writing or running commands, spawn an execution agent — execution agents have the full read/write toolset rooted at the same workspace.

When mode is `off` or `full`: dispatcher behavior unchanged.

### 6.4 Tool surface summary

| Tool | Dispatcher (sandbox) | Execution agent (sandbox) |
|---|---|---|
| Read, LS, Glob | ✓ (path-guarded) | ✓ (path-guarded) |
| Write, Edit, Grep | — | ✓ (path-guarded) |
| Bash | — | ✓ (cwd-rooted, no path guard) |

## 7. Image retention and cleanup

### 7.1 Policy

- Raw image bytes have a TTL of `BOOP_IMAGE_RETENTION_DAYS` days (default 3) from the message's `createdAt`.
- An image is **exempt** from deletion as long as at least one `memoryRecords` row references its `storageId`. If the memory extractor decided the photo was worth keeping, it stays.
- If the last referencing memory record is later pruned (consolidation drops it), the image becomes eligible for cleanup on the next sweep.
- Hard-deleting a message also schedules its images for immediate cleanup, again only if no memory references remain.
- `BOOP_IMAGE_RETENTION_DAYS=0` disables cleanup entirely (debug/testing only).

### 7.2 Implementation (`server/images/clean.ts`, new)

Periodic job (default every 12 hours, configurable):

```
for each message older than RETENTION_DAYS with non-empty imageStorageIds:
  for each storageId on that message:
    if no memoryRecords row contains this storageId:
      delete bytes from Convex storage
      remove id from messages.imageStorageIds
      log to agentLogs: {messageId, storageId, reason: "ttl"}
```

Job is idempotent. Uses the index from §5.5.

### 7.3 Dashboard

- Dashboard tab gains a stat: `"Image storage: N files, X MB total"`.
- Memory tab shows a small image-thumbnail badge next to memory records with non-empty `imageStorageIds`.
- No manual "purge" button in V1.

## 8. Error handling

### 8.1 Image pipeline

| Failure | Behavior |
|---|---|
| Sendblue payload malformed or media URL missing | Skip image, store message text-only, log warning |
| Image download HTTP error or timeout (>10s) | Store message with `mediaError: "download failed: <code>"`, dispatcher sees prepended system note |
| Image exceeds 10MB cap | Reject before full download via `content-length` check, `mediaError: "too large"` |
| Unsupported MIME type | Same `mediaError` path |
| Convex storage upload fails | Same `mediaError` path; bytes dropped (no local disk fallback) |
| Dispatcher SDK call rejects images (Anthropic API error) | Retry SDK call without images, prepend system note: `[image input failed; the user's text was: ...]` |
| `spawn_agent({imageRefs})` references missing storageId | Tool call returns structured error; dispatcher decides to retry without images |
| Memory extraction fails on image turn | Log to `agentLogs`, no record written, don't block user reply — matches current extraction-failure behavior |

### 8.2 Filesystem pipeline

| Failure | Behavior |
|---|---|
| `BOOP_VPS_FILESYSTEM_ACCESS=sandbox` but workspace dir not writable | Fatal at startup, refuse to boot, clear log message |
| `canUseTool` path guard rejects a call | Return structured tool error `"path outside workspace: <path> — workspace is rooted at <root>"`. Not surfaced to chat — the model corrects course. This is the **intended** sandbox behavior, not an exceptional condition. |
| Bash command runs forever | Existing 15-min heartbeat failsafe catches it |
| Bash command produces huge stdout | SDK already truncates; rely on existing behavior |
| Workspace dir removed mid-run | Tools return ENOENT; model sees the error; no special handling |

## 9. Testing strategy

This repo has no existing test framework. Adding **`vitest`** as a dev dependency, with tests focused on high-risk pure-logic code:

1. **Path-sandbox guard** (`server/workspace.ts` → `isPathInWorkspace`):
   - Inside workspace: simple paths, nested paths, paths with `./`
   - Outside workspace: absolute paths above root, parent-traversal (`../`)
   - Edge cases: symlinks (resolve before check), `~` expansion, null bytes, empty string, paths with trailing slash, the workspace root itself
   - This is the most safety-critical test in the feature
2. **MIME and size validation** (`server/sendblue.ts` → new helper):
   - Accepts PNG, JPEG, WebP, GIF under 10MB
   - Rejects PDF, application/octet-stream, missing content-type
   - Rejects 10MB + 1 byte
3. **Content-block builder** (new helper in `server/interaction-agent.ts` or extracted module):
   - Given `{text, imageStorageIds}` and a mock bytes-fetcher, produces correct Anthropic SDK content array structure (base64 encoding, media_type, ordering)
4. **`imageRefs` propagation** (new helper in `server/execution-agent.ts`):
   - `spawn_agent({task, imageRefs})` resolves into expected SDK call shape with image blocks prepended

Everything else is covered by manual smoke tests (§10).

`npm test` script added; CI / pre-commit hookup is out of scope for this design.

## 10. Manual smoke test checklist

Run before merging.

### Images

1. Text Boop a single PNG with caption "what's in this photo?" → reply describes the image
2. Text a JPEG with no caption → reply is contextually appropriate
3. Text two images in one message → both in `_storage`, both visible to dispatcher
4. Text a 15MB image → polite failure, `mediaError` recorded
5. Text a `.pdf` (Sendblue allows non-image attachments) → graceful rejection, message stored text-only
6. Send a photo + ask Boop to "search the web for this product" → execution agent spawns with `imageRefs`, succeeds
7. Wait 24h, send "remember that photo I sent yesterday?" → memory recall surfaces the image-description memory record
8. Inspect Convex dashboard: `_storage` table has entries, `messages.imageStorageIds` populated, `memoryRecords` has description-style record
9. Wait `BOOP_IMAGE_RETENTION_DAYS + 1` days for an image with no memory references → image deleted on next cleanup pass
10. Verify a memory-referenced image survives past the retention window

### Filesystem

With `BOOP_VPS_FILESYSTEM_ACCESS=sandbox` and a default workspace:

11. `touch ~/boop-workspace/notes.txt && echo "remember the milk" > ~/boop-workspace/notes.txt`; text "what's in notes.txt?" → dispatcher uses `Read` directly and replies
12. "list files in my workspace" → dispatcher uses `LS`
13. "write a poem about cats to poem.txt" → dispatcher spawns execution agent; file appears in workspace
14. "read /etc/passwd" → execution agent's Read call blocked by `canUseTool`, model replies "I can only access files in the workspace"
15. "run `ls /`" via Bash → succeeds (per Q7 decision), execution agent reports back; by design
16. With `BOOP_VPS_FILESYSTEM_ACCESS=off`: all FS attempts fail with "tool not available"; dispatcher behavior unchanged from today
17. Restart server with `BOOP_VPS_FILESYSTEM_ACCESS=sandbox` and `BOOP_WORKSPACE_DIR=/nonexistent/readonly` → server refuses to start, fatal log message visible

### Automated

18. `npm test` passes

## 11. Rollout

The two subsystems are independent; either can ship first.

- **Image-only deploy:** Schema migration + image ingest + dispatcher content-blocks + memory extraction + cleanup job. No FS changes. `BOOP_VPS_FILESYSTEM_ACCESS` stays unset.
- **FS-only deploy:** Workspace module + agent tool wiring + dispatcher prompt update + path guard. No image changes.
- **Combined:** Both. Schema migration runs once; env vars opt into each capability separately.

Default config keeps both features off. Existing deployments are unaffected.

## 12. Out of scope / future work

- Outbound MMS (sending images back to the user). Sendblue supports it; adding it later does not require revisiting this design.
- Image generation tools (e.g., Anthropic does not currently support image generation; a future integration could route through Composio).
- Per-conversation workspace partitioning.
- Manual purge/admin UI for storage cleanup.
- A web UI on the dashboard for browsing workspace files.
- Hardening `Bash` with path-aware constraints. Currently Bash is `cwd`-rooted only.

## 13. Schema migration notes

All schema additions are optional (`v.optional(...)`). No backfill needed. Existing rows continue to work. The new index on `messages` is additive.
