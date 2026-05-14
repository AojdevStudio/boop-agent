# Image viewing + sandboxed filesystem access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two optional capabilities to Boop: (1) image viewing for iMessage attachments, with propagation to execution agents and memory extraction, and (2) sandboxed filesystem access for execution agents and read-only access for the dispatcher.

**Architecture:** Both features are gated by env vars and default off. Images flow Sendblue → bytes downloaded → Convex storage → SDK content blocks → memory extraction. Filesystem extends `BOOP_VPS_FILESYSTEM_ACCESS` with a `sandbox` value that rotates the agent SDK calls to use `cwd=$BOOP_WORKSPACE_DIR` and a `canUseTool` callback that path-guards file tools.

**Tech Stack:** TypeScript, Node 20+, Express, Convex (file storage + tables), Claude Agent SDK, Sendblue webhook for MMS, vitest (new dev dep).

**Spec:** `docs/superpowers/specs/2026-05-13-image-and-fs-access-design.md`

---

## File Structure

**New files:**
- `server/workspace.ts` — workspace resolution + path-guard helper
- `server/images/clean.ts` — periodic cleanup job for expired image bytes
- `server/images/content-blocks.ts` — helper that builds Anthropic content arrays from text + storageIds
- `server/images/mime.ts` — MIME and size validation helper
- `vitest.config.ts` — vitest config
- `test/workspace.test.ts` — path-guard tests
- `test/mime.test.ts` — MIME/size tests
- `test/content-blocks.test.ts` — content array builder tests

**Modified files:**
- `package.json` — add vitest dev dep + `test` script
- `convex/schema.ts` — extend `messages` (`imageStorageIds`, `mediaError`) and `memoryRecords` (`imageStorageIds`)
- `convex/messages.ts` — extend `send` mutation args + `recentWithImages` query
- `convex/memoryRecords.ts` — extend `upsert` mutation args
- `convex/_generated/api.d.ts` and friends regenerate themselves via `convex dev`
- `server/sendblue.ts` — image download + dedicated MMS payload typing
- `server/interaction-agent.ts` — sandbox-mode tool wiring, content-block input, system prompt patches, `imageRefs` on `spawn_agent`
- `server/execution-agent.ts` — sandbox-mode tool wiring, `canUseTool`, image content-block prefix
- `server/memory/extract.ts` — image-aware extraction
- `server/index.ts` — register image-cleanup interval
- `.env.example` (if it doesn't exist, create it) — document `BOOP_VPS_FILESYSTEM_ACCESS=sandbox`, `BOOP_WORKSPACE_DIR`, `BOOP_IMAGE_RETENTION_DAYS`

Files split by responsibility: workspace logic in one module, image helpers in their own subdirectory under `server/images/`. Each helper is independently unit-testable.

---

## Phase 0 — Test infrastructure

### Task 1: Add vitest + npm test script

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1.1: Install vitest**

```bash
cd /opt/boop-agent && npm install --save-dev vitest@^2
```

Expected: vitest added to `devDependencies`, no errors.

- [ ] **Step 1.2: Add npm test script**

Modify `package.json` scripts block. Find the existing `"typecheck"` line and add `"test"` and `"test:watch"` after it:

```json
"scripts": {
    "setup": "tsx scripts/setup.ts",
    "sendblue:sync": "node scripts/sendblue-sync.mjs",
    "sendblue:webhook": "node scripts/sendblue-webhook.mjs",
    "preflight": "node scripts/preflight.mjs",
    "dev": "node scripts/dev.mjs",
    "dev:parallel": "npm-run-all --parallel dev:server dev:convex dev:debug",
    "dev:server": "npm run preflight && tsx watch server/index.ts",
    "dev:convex": "convex dev",
    "dev:debug": "vite --config debug/vite.config.ts",
    "build:debug": "vite build --config debug/vite.config.ts",
    "start": "npm run preflight && tsx server/index.ts",
    "deploy:convex": "convex deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
}
```

- [ ] **Step 1.3: Create vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10000,
  },
});
```

- [ ] **Step 1.4: Verify vitest runs (no tests yet)**

```bash
cd /opt/boop-agent && npm test
```

Expected: vitest exits 0 with "No test files found" or similar — fine because we have no tests yet.

- [ ] **Step 1.5: Commit**

```bash
cd /tmp/boop-agent-pr && git add package.json package-lock.json vitest.config.ts && git commit -m "$(cat <<'EOF'
chore(test): add vitest for unit tests on high-risk pure-logic code

Test framework introduced specifically for the path-sandbox guard
and image helpers landing in subsequent commits. Test files live
under test/ at the repo root.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Note: this plan uses `/tmp/boop-agent-pr` as the git working dir (set up during brainstorming) and `/opt/boop-agent` as the live edit dir. After each commit, copy the changed files from `/opt/boop-agent` to `/tmp/boop-agent-pr` before running `git add`. To keep the steps short, the commit step in each task already includes the `cp` for the changed files.

---

## Phase 1 — Filesystem foundation

### Task 2: Workspace module with path-guard (TDD)

**Files:**
- Create: `server/workspace.ts`
- Test: `test/workspace.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `test/workspace.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkspace, type WorkspaceConfig } from "../server/workspace.js";

let workspaceRoot: string;
let outside: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "boop-ws-"));
  outside = mkdtempSync(join(tmpdir(), "boop-outside-"));
  writeFileSync(join(workspaceRoot, "inside.txt"), "x");
  writeFileSync(join(outside, "outside.txt"), "y");
  // Symlink inside workspace pointing OUT of it — must be detected.
  symlinkSync(join(outside, "outside.txt"), join(workspaceRoot, "evil-link"));
  // Inner real subdir to confirm legit nested paths pass.
  mkdirSync(join(workspaceRoot, "sub"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function ws(): WorkspaceConfig {
  return resolveWorkspace({ mode: "sandbox", dir: workspaceRoot });
}

describe("isPathInWorkspace", () => {
  it("accepts the workspace root itself", () => {
    expect(ws().isPathInWorkspace(workspaceRoot)).toBe(true);
  });
  it("accepts a file directly inside the workspace", () => {
    expect(ws().isPathInWorkspace(join(workspaceRoot, "inside.txt"))).toBe(true);
  });
  it("accepts a nested subdir", () => {
    expect(ws().isPathInWorkspace(join(workspaceRoot, "sub"))).toBe(true);
  });
  it("normalises `./` segments", () => {
    expect(ws().isPathInWorkspace(join(workspaceRoot, "./inside.txt"))).toBe(true);
  });
  it("rejects parent traversal", () => {
    expect(ws().isPathInWorkspace(join(workspaceRoot, "..", "outside.txt"))).toBe(false);
  });
  it("rejects an absolute path outside the workspace", () => {
    expect(ws().isPathInWorkspace(join(outside, "outside.txt"))).toBe(false);
  });
  it("rejects /etc/passwd-style absolute path", () => {
    expect(ws().isPathInWorkspace("/etc/passwd")).toBe(false);
  });
  it("rejects a symlink that resolves outside the workspace", () => {
    expect(ws().isPathInWorkspace(join(workspaceRoot, "evil-link"))).toBe(false);
  });
  it("rejects empty string", () => {
    expect(ws().isPathInWorkspace("")).toBe(false);
  });
  it("rejects strings containing a null byte", () => {
    expect(ws().isPathInWorkspace(join(workspaceRoot, "x\x00y"))).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  it("returns mode=off when mode is off, regardless of dir", () => {
    const w = resolveWorkspace({ mode: "off", dir: workspaceRoot });
    expect(w.mode).toBe("off");
  });
  it("returns mode=full unchanged when mode is full", () => {
    const w = resolveWorkspace({ mode: "full", dir: workspaceRoot });
    expect(w.mode).toBe("full");
  });
  it("throws on sandbox mode if dir does not resolve", () => {
    expect(() =>
      resolveWorkspace({ mode: "sandbox", dir: "/this/does/not/exist/anywhere" }),
    ).toThrow(/workspace/i);
  });
});
```

- [ ] **Step 2.2: Run tests, confirm they fail**

```bash
cd /opt/boop-agent && npm test
```

Expected: tests fail with "Cannot find module ../server/workspace.js" or similar.

- [ ] **Step 2.3: Create the workspace module**

Create `server/workspace.ts`:

```ts
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type WorkspaceMode = "off" | "sandbox" | "full";

export interface WorkspaceConfig {
  mode: WorkspaceMode;
  root: string;
  isPathInWorkspace: (candidate: string) => boolean;
}

export interface ResolveWorkspaceOpts {
  mode?: WorkspaceMode | string;
  dir?: string;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function parseMode(raw: string | undefined): WorkspaceMode {
  if (raw === "full") return "full";
  if (raw === "sandbox") return "sandbox";
  return "off";
}

export function resolveWorkspace(
  opts: ResolveWorkspaceOpts = {},
): WorkspaceConfig {
  const mode = parseMode(opts.mode ?? process.env.BOOP_VPS_FILESYSTEM_ACCESS);
  const rawDir =
    opts.dir ?? process.env.BOOP_WORKSPACE_DIR ?? "~/boop-workspace";
  const expanded = path.resolve(expandHome(rawDir));

  // `full` and `off` don't validate the workspace dir — they don't use it.
  if (mode !== "sandbox") {
    return {
      mode,
      root: expanded,
      isPathInWorkspace: () => false,
    };
  }

  if (!existsSync(expanded)) {
    try {
      mkdirSync(expanded, { recursive: true });
    } catch (err) {
      throw new Error(
        `workspace dir cannot be created at ${expanded}: ${String(err)}`,
      );
    }
  }
  let canonical: string;
  try {
    canonical = realpathSync(expanded);
    const stats = statSync(canonical);
    if (!stats.isDirectory()) {
      throw new Error(`workspace path ${canonical} is not a directory`);
    }
  } catch (err) {
    throw new Error(
      `workspace dir not usable at ${expanded}: ${String(err)}`,
    );
  }

  const rootWithSep = canonical.endsWith(path.sep)
    ? canonical
    : canonical + path.sep;

  const isPathInWorkspace = (candidate: string): boolean => {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    if (candidate.includes("\x00")) return false;
    let resolved: string;
    try {
      resolved = path.resolve(canonical, candidate);
      if (existsSync(resolved)) resolved = realpathSync(resolved);
    } catch {
      return false;
    }
    if (resolved === canonical) return true;
    return resolved.startsWith(rootWithSep);
  };

  return { mode, root: canonical, isPathInWorkspace };
}

// Module-level singleton for production use. Tests should call
// resolveWorkspace directly with explicit opts to avoid coupling to env.
let cached: WorkspaceConfig | null = null;
export function getWorkspace(): WorkspaceConfig {
  if (!cached) cached = resolveWorkspace();
  return cached;
}
```

- [ ] **Step 2.4: Run tests, confirm they pass**

```bash
cd /opt/boop-agent && npm test
```

Expected: all 13 workspace tests pass.

- [ ] **Step 2.5: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 2.6: Commit**

```bash
cp /opt/boop-agent/server/workspace.ts /tmp/boop-agent-pr/server/workspace.ts && \
mkdir -p /tmp/boop-agent-pr/test && \
cp /opt/boop-agent/test/workspace.test.ts /tmp/boop-agent-pr/test/workspace.test.ts && \
cd /tmp/boop-agent-pr && git add server/workspace.ts test/workspace.test.ts && \
git commit -m "$(cat <<'EOF'
feat(workspace): add workspace resolver + path-guard

resolveWorkspace() parses BOOP_VPS_FILESYSTEM_ACCESS and
BOOP_WORKSPACE_DIR, canonicalises the directory, and exposes
isPathInWorkspace() which rejects parent-traversal, out-of-root
symlinks, null bytes, and empty input. Sandbox mode throws if the
dir cannot be created or resolved. off/full modes preserve current
behavior and skip workspace validation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Wire sandbox mode into execution agent

### Task 3: Execution agent reads sandbox mode and applies cwd + tool allowlist + canUseTool

**Files:**
- Modify: `server/execution-agent.ts` (lines 130-180 currently set tools and SDK opts)

- [ ] **Step 3.1: Add canUseTool helper at top of execution-agent.ts**

In `server/execution-agent.ts`, after the existing imports near line 12, add:

```ts
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { getWorkspace } from "./workspace.js";
```

Then near the top of the file (before `spawnExecutionAgent`), add a helper:

```ts
const PATH_GUARDED_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
]);

function makeWorkspaceCanUseTool(
  isPathInWorkspace: (p: string) => boolean,
  workspaceRoot: string,
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (!PATH_GUARDED_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const pathArg =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.pattern === "string"
        ? input.pattern
        : undefined;
    if (!pathArg) {
      return { behavior: "allow", updatedInput: input };
    }
    if (!isPathInWorkspace(pathArg)) {
      return {
        behavior: "deny",
        message: `path outside workspace: ${pathArg} — workspace is rooted at ${workspaceRoot}`,
      };
    }
    return { behavior: "allow", updatedInput: input };
  };
}
```

- [ ] **Step 3.2: Replace the legacy `fullVpsFilesystemAccess` block**

In `server/execution-agent.ts` around lines 130-153, replace the block that reads `BOOP_VPS_FILESYSTEM_ACCESS` and builds tools/allowedTools. Current block:

```ts
  const fullVpsFilesystemAccess = process.env.BOOP_VPS_FILESYSTEM_ACCESS === "full";
  const builtinTools = fullVpsFilesystemAccess
    ? ({ type: "preset" as const, preset: "claude_code" as const })
    : ["WebSearch", "WebFetch", "Skill"];
  const autoAllowedBuiltins = fullVpsFilesystemAccess
    ? [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "Glob",
        "Grep",
        "LS",
        "WebSearch",
        "WebFetch",
        "Task",
        "Skill",
      ]
    : ["WebSearch", "WebFetch", "Skill"];
  const allowedTools = [
    ...autoAllowedBuiltins,
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
  ];
```

Replace with:

```ts
  const ws = getWorkspace();
  const sandboxBuiltinNames = [
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Glob",
    "Grep",
    "LS",
    "Bash",
    "WebSearch",
    "WebFetch",
    "Skill",
  ];
  const builtinTools =
    ws.mode === "full"
      ? ({ type: "preset" as const, preset: "claude_code" as const })
      : ws.mode === "sandbox"
      ? sandboxBuiltinNames
      : ["WebSearch", "WebFetch", "Skill"];
  const autoAllowedBuiltins =
    ws.mode === "full"
      ? [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "MultiEdit",
          "Glob",
          "Grep",
          "LS",
          "WebSearch",
          "WebFetch",
          "Task",
          "Skill",
        ]
      : ws.mode === "sandbox"
      ? sandboxBuiltinNames
      : ["WebSearch", "WebFetch", "Skill"];
  const allowedTools = [
    ...autoAllowedBuiltins,
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
  ];
  const canUseTool =
    ws.mode === "sandbox"
      ? makeWorkspaceCanUseTool(ws.isPathInWorkspace, ws.root)
      : undefined;
  const sdkCwd = ws.mode === "sandbox" ? ws.root : undefined;
```

- [ ] **Step 3.3: Pass `canUseTool` and `cwd` to the SDK query call**

In the same file, find the `query({ prompt: opts.task, options: { ... } })` call (around lines 163-181) and add `canUseTool` and `cwd` to the options object. Current `options` block:

```ts
      options: {
        systemPrompt: EXECUTION_SYSTEM,
        model: requestedModel,
        mcpServers,
        tools: builtinTools,
        allowedTools,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        abortController: abort,
      },
```

Replace with:

```ts
      options: {
        systemPrompt: EXECUTION_SYSTEM,
        model: requestedModel,
        mcpServers,
        tools: builtinTools,
        allowedTools,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        abortController: abort,
        ...(canUseTool ? { canUseTool } : {}),
        ...(sdkCwd ? { cwd: sdkCwd } : {}),
      },
```

The conditional spreads keep `cwd`/`canUseTool` absent from `options` when not in sandbox mode, so the SDK keeps its default behavior.

- [ ] **Step 3.4: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3.5: Commit**

```bash
cp /opt/boop-agent/server/execution-agent.ts /tmp/boop-agent-pr/server/execution-agent.ts && \
cd /tmp/boop-agent-pr && git add server/execution-agent.ts && \
git commit -m "$(cat <<'EOF'
feat(execution-agent): support BOOP_VPS_FILESYSTEM_ACCESS=sandbox

When sandbox mode is enabled, execution agents get the file/Bash
tools rooted at BOOP_WORKSPACE_DIR via SDK cwd, plus a canUseTool
callback that denies path-guarded file tools (Read/Write/Edit/
MultiEdit/Glob/Grep/LS) whose path argument resolves outside the
workspace. Bash is cwd-rooted only. Existing full and off modes are
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Wire dispatcher for sandbox read-only

### Task 4: Add Read/LS/Glob to dispatcher under sandbox mode, with the same path guard

**Files:**
- Modify: `server/interaction-agent.ts` (lines 313-361 contain the SDK options block)

- [ ] **Step 4.1: Import workspace + canUseTool helper**

In `server/interaction-agent.ts`, after the existing imports near line 14, add:

```ts
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { getWorkspace } from "./workspace.js";
```

Also export the path-guard helper from execution-agent so we only have one copy. In `server/execution-agent.ts`, find `function makeWorkspaceCanUseTool(...)` and change `function` to `export function`. Then in interaction-agent.ts, import it:

```ts
import { makeWorkspaceCanUseTool } from "./execution-agent.js";
```

(Move the import below the existing `import { availableIntegrations, spawnExecutionAgent } from "./execution-agent.js";` line so both imports are grouped.)

- [ ] **Step 4.2: Compute workspace-aware options before the SDK call**

In `server/interaction-agent.ts`, find the block right before the `for await (const msg of query({...}))` call (around line 310). Add:

```ts
  const ws = getWorkspace();
  const dispatcherReadOnlyTools = ["Read", "LS", "Glob"];
  const sandboxAllowed =
    ws.mode === "sandbox" ? dispatcherReadOnlyTools : [];
  const sandboxDisallowedRemoval = new Set(
    ws.mode === "sandbox" ? dispatcherReadOnlyTools : [],
  );
  const sandboxCanUseTool: CanUseTool | undefined =
    ws.mode === "sandbox"
      ? makeWorkspaceCanUseTool(ws.isPathInWorkspace, ws.root)
      : undefined;
  const sandboxCwd = ws.mode === "sandbox" ? ws.root : undefined;
```

- [ ] **Step 4.3: Merge sandbox options into the SDK call**

In the same file, the existing `options` object (around line 315-361) is:

```ts
      options: {
        systemPrompt,
        model: requestedModel,
        mcpServers: { ... },
        allowedTools: [ ...existing mcp__ list... ],
        disallowedTools: [
          "WebSearch",
          "WebFetch",
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Agent",
          "Skill",
        ],
        permissionMode: "bypassPermissions",
      },
```

Modify it so:
1. `allowedTools` includes `...sandboxAllowed`
2. `disallowedTools` filters out anything in `sandboxDisallowedRemoval`
3. Add `tools: sandboxAllowed.length > 0 ? sandboxAllowed : undefined` so the SDK actually exposes the built-ins (without this, `allowedTools` is a no-op for built-ins).
4. Add `canUseTool` and `cwd` conditionally

Replace `allowedTools` and `disallowedTools` and add the new fields:

```ts
      options: {
        systemPrompt,
        model: requestedModel,
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-ack": ackServer,
          "boop-self": selfServer,
        },
        ...(sandboxAllowed.length > 0 ? { tools: sandboxAllowed } : {}),
        allowedTools: [
          ...sandboxAllowed,
          "mcp__boop-memory__write_memory",
          "mcp__boop-memory__recall",
          "mcp__boop-spawn__spawn_agent",
          "mcp__boop-automations__create_automation",
          "mcp__boop-automations__list_automations",
          "mcp__boop-automations__toggle_automation",
          "mcp__boop-automations__delete_automation",
          "mcp__boop-draft-decisions__list_drafts",
          "mcp__boop-draft-decisions__send_draft",
          "mcp__boop-draft-decisions__reject_draft",
          "mcp__boop-ack__send_ack",
          "mcp__boop-self__get_config",
          "mcp__boop-self__set_model",
          "mcp__boop-self__set_timezone",
          "mcp__boop-self__list_integrations",
          "mcp__boop-self__search_composio_catalog",
          "mcp__boop-self__inspect_toolkit",
        ],
        disallowedTools: [
          "WebSearch",
          "WebFetch",
          "Bash",
          "Write",
          "Edit",
          "Grep",
          "Agent",
          ...(sandboxDisallowedRemoval.has("Read") ? [] : ["Read"]),
          ...(sandboxDisallowedRemoval.has("Glob") ? [] : ["Glob"]),
          "Skill",
        ],
        permissionMode: "bypassPermissions",
        ...(sandboxCanUseTool ? { canUseTool: sandboxCanUseTool } : {}),
        ...(sandboxCwd ? { cwd: sandboxCwd } : {}),
      },
```

- [ ] **Step 4.4: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4.5: Commit**

```bash
cp /opt/boop-agent/server/interaction-agent.ts /tmp/boop-agent-pr/server/interaction-agent.ts && \
cp /opt/boop-agent/server/execution-agent.ts /tmp/boop-agent-pr/server/execution-agent.ts && \
cd /tmp/boop-agent-pr && git add server/interaction-agent.ts server/execution-agent.ts && \
git commit -m "$(cat <<'EOF'
feat(interaction-agent): read-only workspace access under sandbox mode

Under BOOP_VPS_FILESYSTEM_ACCESS=sandbox the dispatcher gains
Read/LS/Glob (rooted at BOOP_WORKSPACE_DIR) so it can answer quick
'what's in my workspace?' questions without spawning. Path-guarded
via the same canUseTool helper used by execution agents.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Update dispatcher system prompt for sandbox

**Files:**
- Modify: `server/interaction-agent.ts` (the `INTERACTION_SYSTEM` template at lines 16-168)

- [ ] **Step 5.1: Add a placeholder for the FS line in the system prompt**

In `server/interaction-agent.ts`, find the line in `INTERACTION_SYSTEM` that says:

```
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
```

Replace it with the placeholder:

```
You have NO browser, NO WebSearch, NO WebFetch, NO APIs.
{{FILESYSTEM_LINE}}
```

- [ ] **Step 5.2: Build the FS line dynamically**

In the `handleUserMessage` function in the same file, find the spot where `systemPrompt` is built (around line 296 — `const systemPrompt = INTERACTION_SYSTEM.replace(...)`). Replace that block with:

```ts
  const wsForPrompt = getWorkspace();
  const filesystemLine =
    wsForPrompt.mode === "sandbox"
      ? `You have READ-ONLY access to a workspace directory at ${wsForPrompt.root} via the Read, LS, and Glob tools. Use them for quick "what's in this file" lookups. For anything that writes or runs commands, spawn an execution agent — execution agents have full read/write/Bash rooted at the same workspace.`
      : "You have NO file access.";
  const systemPrompt = INTERACTION_SYSTEM.replace(
    "{{INTEGRATIONS}}",
    integrations.join(", ") || "(no integrations configured yet)",
  ).replace("{{FILESYSTEM_LINE}}", filesystemLine);
```

- [ ] **Step 5.3: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 5.4: Commit**

```bash
cp /opt/boop-agent/server/interaction-agent.ts /tmp/boop-agent-pr/server/interaction-agent.ts && \
cd /tmp/boop-agent-pr && git add server/interaction-agent.ts && \
git commit -m "$(cat <<'EOF'
feat(interaction-agent): system-prompt switch for sandbox-mode FS access

When sandbox mode is enabled, the dispatcher prompt advertises the
read-only workspace tools and tells the model to delegate writes to
an execution agent. Off mode keeps the existing 'no file access'
wording.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Image schema additions

### Task 6: Schema fields on messages and memoryRecords

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 6.1: Extend the `messages` table**

In `convex/schema.ts`, find the `messages: defineTable({...})` definition at lines 5-14. Replace it with:

```ts
  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_turn", ["conversationId", "turnId"])
    .index("by_createdAt", ["createdAt"]),
```

The new `by_createdAt` index supports the cleanup-sweep query in Task 16.

- [ ] **Step 6.2: Extend the `memoryRecords` table**

In `convex/schema.ts`, find the `memoryRecords: defineTable({...})` definition (around lines 24-50). Read the existing schema, locate the closing `}` of the object literal passed to `defineTable`, and add the new field just before that `}`:

```ts
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
```

(All existing fields and indexes stay as-is.)

- [ ] **Step 6.3: Push schema to dev Convex**

```bash
cd /opt/boop-agent && npx convex dev --once 2>&1 | tail -20
```

Expected: schema accepted; `convex/_generated/*` files are regenerated. The migration is non-breaking (all new fields are optional).

- [ ] **Step 6.4: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 6.5: Commit**

```bash
cp /opt/boop-agent/convex/schema.ts /tmp/boop-agent-pr/convex/schema.ts && \
cd /tmp/boop-agent-pr && git add convex/schema.ts && \
git commit -m "$(cat <<'EOF'
feat(convex): add imageStorageIds + mediaError to messages and imageStorageIds to memoryRecords

All new fields are optional; existing rows are unaffected. A new
by_createdAt index on messages supports the image-cleanup sweep
landing in a later commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Sendblue image ingestion

### Task 7: MIME + size validation helper (TDD)

**Files:**
- Create: `server/images/mime.ts`
- Test: `test/mime.test.ts`

- [ ] **Step 7.1: Write the failing tests**

Create `test/mime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateImageHeader, ALLOWED_IMAGE_MIME } from "../server/images/mime.js";

const TEN_MB = 10 * 1024 * 1024;

describe("validateImageHeader", () => {
  it("accepts image/png under cap", () => {
    expect(
      validateImageHeader({ contentType: "image/png", contentLength: 1024 }),
    ).toEqual({ ok: true, mediaType: "image/png" });
  });
  it("accepts image/jpeg under cap", () => {
    expect(
      validateImageHeader({ contentType: "image/jpeg; charset=binary", contentLength: 500_000 }),
    ).toEqual({ ok: true, mediaType: "image/jpeg" });
  });
  it("accepts image/webp", () => {
    expect(
      validateImageHeader({ contentType: "image/webp", contentLength: 1 }),
    ).toEqual({ ok: true, mediaType: "image/webp" });
  });
  it("accepts image/gif", () => {
    expect(
      validateImageHeader({ contentType: "image/gif", contentLength: 1 }),
    ).toEqual({ ok: true, mediaType: "image/gif" });
  });
  it("rejects application/pdf", () => {
    expect(
      validateImageHeader({ contentType: "application/pdf", contentLength: 1 }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/mime|type/i) });
  });
  it("rejects application/octet-stream", () => {
    expect(
      validateImageHeader({ contentType: "application/octet-stream", contentLength: 1 }),
    ).toMatchObject({ ok: false });
  });
  it("rejects missing content-type", () => {
    expect(
      validateImageHeader({ contentType: undefined, contentLength: 1 }),
    ).toMatchObject({ ok: false });
  });
  it("rejects oversize even with valid mime", () => {
    expect(
      validateImageHeader({ contentType: "image/png", contentLength: TEN_MB + 1 }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/too large|size/i) });
  });
  it("rejects exactly cap+1", () => {
    expect(
      validateImageHeader({ contentType: "image/jpeg", contentLength: TEN_MB + 1 }),
    ).toMatchObject({ ok: false });
  });
  it("accepts exactly the cap", () => {
    expect(
      validateImageHeader({ contentType: "image/jpeg", contentLength: TEN_MB }),
    ).toMatchObject({ ok: true });
  });
  it("exposes the allowed mime set", () => {
    expect(ALLOWED_IMAGE_MIME.has("image/png")).toBe(true);
    expect(ALLOWED_IMAGE_MIME.has("image/heic")).toBe(false);
  });
});
```

- [ ] **Step 7.2: Run tests, confirm they fail**

```bash
cd /opt/boop-agent && npm test
```

Expected: tests fail with "Cannot find module ../server/images/mime.js".

- [ ] **Step 7.3: Create the MIME helper**

Create `server/images/mime.ts`:

```ts
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type ImageHeaderCheck =
  | { ok: true; mediaType: ImageMediaType }
  | { ok: false; reason: string };

export interface ImageHeader {
  contentType: string | undefined;
  contentLength: number | undefined;
}

function normalizeContentType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const semi = raw.indexOf(";");
  const trimmed = (semi >= 0 ? raw.slice(0, semi) : raw).trim().toLowerCase();
  return trimmed || undefined;
}

export function validateImageHeader(header: ImageHeader): ImageHeaderCheck {
  const mime = normalizeContentType(header.contentType);
  if (!mime) return { ok: false, reason: "missing content-type" };
  if (!ALLOWED_IMAGE_MIME.has(mime)) {
    return { ok: false, reason: `disallowed mime type: ${mime}` };
  }
  if (typeof header.contentLength === "number" && header.contentLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `image too large: ${header.contentLength} bytes` };
  }
  return { ok: true, mediaType: mime as ImageMediaType };
}
```

- [ ] **Step 7.4: Run tests, confirm they pass**

```bash
cd /opt/boop-agent && npm test
```

Expected: all 11 mime tests pass; previous workspace tests still pass.

- [ ] **Step 7.5: Commit**

```bash
mkdir -p /tmp/boop-agent-pr/server/images && \
cp /opt/boop-agent/server/images/mime.ts /tmp/boop-agent-pr/server/images/mime.ts && \
cp /opt/boop-agent/test/mime.test.ts /tmp/boop-agent-pr/test/mime.test.ts && \
cd /tmp/boop-agent-pr && git add server/images/mime.ts test/mime.test.ts && \
git commit -m "$(cat <<'EOF'
feat(images): validateImageHeader helper + tests

Pure-logic validator with no side effects: accepts jpeg/png/webp/
gif under a 10 MB cap, rejects everything else. The full image
ingest pipeline calls this against the HEAD response before
downloading the body.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Sendblue image download path + Convex storage upload

**Files:**
- Modify: `convex/messages.ts` (extend `send` mutation args; add `recentWithImages` query stub for later)
- Modify: `server/sendblue.ts` (new image-ingest helper, call it from `processInboundMessage`)

- [ ] **Step 8.1: Extend `messages.send` mutation in Convex**

In `convex/messages.ts`, replace the entire file with:

```ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const send = mutation({
  args: {
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("messages", { ...args, createdAt: now });

    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (conv) {
      await ctx.db.patch(conv._id, {
        messageCount: conv.messageCount + 1,
        lastActivityAt: now,
      });
    } else {
      await ctx.db.insert("conversations", {
        conversationId: args.conversationId,
        messageCount: 1,
        lastActivityAt: now,
      });
    }
    return id;
  },
});

export const list = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const recent = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 20);
    return msgs.reverse();
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const getStorageUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});
```

- [ ] **Step 8.2: Push schema/mutations to dev Convex**

```bash
cd /opt/boop-agent && npx convex dev --once 2>&1 | tail -20
```

Expected: 0 errors, generated API includes `api.messages.generateUploadUrl` and `api.messages.getStorageUrl`.

- [ ] **Step 8.3: Add image-ingest helper to sendblue.ts**

In `server/sendblue.ts`, after the imports at line 5, add:

```ts
import { validateImageHeader, MAX_IMAGE_BYTES, type ImageMediaType } from "./images/mime.js";
```

Then near the bottom of the file (before `export function createSendblueRouter`), add:

```ts
type IngestedImage = { storageId: string; mediaType: ImageMediaType };

export async function ingestSendblueImage(
  url: string,
): Promise<{ ok: true; image: IngestedImage } | { ok: false; reason: string }> {
  let head: Response;
  try {
    head = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  if (!head.ok) {
    return { ok: false, reason: `download failed: HTTP ${head.status}` };
  }
  const lenHeader = head.headers.get("content-length");
  const contentLength = lenHeader ? Number(lenHeader) : undefined;
  const check = validateImageHeader({
    contentType: head.headers.get("content-type") ?? undefined,
    contentLength,
  });
  if (!check.ok) {
    head.body?.cancel().catch(() => undefined);
    return { ok: false, reason: check.reason };
  }
  const buf = await head.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `image too large: ${buf.byteLength} bytes` };
  }

  const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": check.mediaType },
    body: buf,
  });
  if (!upload.ok) {
    return { ok: false, reason: `upload failed: HTTP ${upload.status}` };
  }
  const { storageId } = (await upload.json()) as { storageId: string };
  return { ok: true, image: { storageId, mediaType: check.mediaType } };
}
```

- [ ] **Step 8.4: Update `SendblueInbound` and `processInboundMessage` to handle MMS**

In the same file, find the `SendblueInbound` type at line 122. Replace it with:

```ts
type SendblueInbound = {
  content?: unknown;
  from_number?: unknown;
  is_outbound?: unknown;
  message_handle?: unknown;
  date_sent?: unknown;
  media_url?: unknown; // single image (legacy)
  media_urls?: unknown; // array of images (current)
};
```

Then in `processInboundMessage`, after line 134 (`if (raw.is_outbound || !content || !from_number) return "skipped";` — note: keep the `!content` clause for now; we'll relax it below to allow image-only messages), modify the early-return:

Old:
```ts
  if (raw.is_outbound || !content || !from_number) return "skipped";
```

New:
```ts
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
```

Then later in the same function, after the dedup check (`if (!claimed) return "deduped";`) and before the existing `const conversationId = ...` line, add the image-ingest block:

```ts
  const ingested: IngestedImage[] = [];
  const ingestErrors: string[] = [];
  for (const url of rawUrls) {
    const r = await ingestSendblueImage(url);
    if (r.ok) ingested.push(r.image);
    else ingestErrors.push(r.reason);
  }
```

The `IngestedImage` type is already exported indirectly; for the explicit annotation in this file, add at the top alongside the `ingestSendblueImage` import (or re-declare locally — simpler):

In the same file, near the top after the `validateImageHeader` import, also add:

```ts
type IngestedImage = { storageId: string; mediaType: ImageMediaType };
```

Then refactor the existing `await handleUserMessage({...})` call (~line 153) to pass the new info. Replace this section:

Old:
```ts
  const stopTyping = startTypingLoop(from_number);
  try {
    const reply = await handleUserMessage({
      conversationId,
      content,
      turnTag,
      onThinking: (t) => broadcast("thinking", { conversationId, t }),
    });
```

New:
```ts
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
```

- [ ] **Step 8.5: Run typecheck**

This step will fail until Task 9 updates `HandleOpts`. That's expected and intentional — we commit Task 8 + Task 9 together. Skip the typecheck here.

- [ ] **Step 8.6: Defer commit to end of Task 9**

(No commit yet — Task 9 depends on this.)

---

## Phase 6 — Dispatcher consumes images

### Task 9: Content-block builder + dispatcher accepts images

**Files:**
- Create: `server/images/content-blocks.ts`
- Test: `test/content-blocks.test.ts`
- Modify: `server/interaction-agent.ts` (extend `HandleOpts`, build content array)

- [ ] **Step 9.1: Write the failing tests for the content-block builder**

Create `test/content-blocks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPromptWithImages } from "../server/images/content-blocks.js";

const fakeFetch = (mapping: Record<string, { bytes: Buffer; mediaType: string }>) =>
  async (id: string) => {
    const hit = mapping[id];
    if (!hit) throw new Error(`no fake for ${id}`);
    return hit;
  };

describe("buildPromptWithImages", () => {
  it("returns the plain text string when no images", async () => {
    const res = await buildPromptWithImages({
      text: "hello",
      imageStorageIds: undefined,
      fetchBytes: fakeFetch({}),
    });
    expect(res).toBe("hello");
  });
  it("returns the text when imageStorageIds is empty", async () => {
    const res = await buildPromptWithImages({
      text: "hi",
      imageStorageIds: [],
      fetchBytes: fakeFetch({}),
    });
    expect(res).toBe("hi");
  });
  it("returns a content array with image blocks first then text", async () => {
    const res = await buildPromptWithImages({
      text: "what is this",
      imageStorageIds: ["id1"],
      fetchBytes: fakeFetch({
        id1: { bytes: Buffer.from([1, 2, 3]), mediaType: "image/png" },
      }),
    });
    expect(Array.isArray(res)).toBe(true);
    const arr = res as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.from([1, 2, 3]).toString("base64"),
      },
    });
    expect(arr[1]).toEqual({ type: "text", text: "what is this" });
  });
  it("preserves image order when multiple ids", async () => {
    const res = (await buildPromptWithImages({
      text: "x",
      imageStorageIds: ["a", "b"],
      fetchBytes: fakeFetch({
        a: { bytes: Buffer.from([1]), mediaType: "image/jpeg" },
        b: { bytes: Buffer.from([2]), mediaType: "image/png" },
      }),
    })) as Array<Record<string, unknown>>;
    expect((res[0] as { source: { media_type: string } }).source.media_type).toBe("image/jpeg");
    expect((res[1] as { source: { media_type: string } }).source.media_type).toBe("image/png");
    expect(res[2]).toEqual({ type: "text", text: "x" });
  });
  it("uses empty text block when text is missing but images are present", async () => {
    const res = (await buildPromptWithImages({
      text: "",
      imageStorageIds: ["id1"],
      fetchBytes: fakeFetch({
        id1: { bytes: Buffer.from([1]), mediaType: "image/png" },
      }),
    })) as Array<Record<string, unknown>>;
    expect(res).toHaveLength(2);
    expect(res[1]).toEqual({ type: "text", text: "(image)" });
  });
  it("rethrows when fetchBytes rejects", async () => {
    await expect(
      buildPromptWithImages({
        text: "x",
        imageStorageIds: ["missing"],
        fetchBytes: async () => {
          throw new Error("not found");
        },
      }),
    ).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 9.2: Run tests, confirm they fail**

```bash
cd /opt/boop-agent && npm test
```

Expected: 6 content-blocks tests fail with "Cannot find module ../server/images/content-blocks.js".

- [ ] **Step 9.3: Create the content-block builder**

Create `server/images/content-blocks.ts`:

```ts
export interface ImageBytes {
  bytes: Buffer;
  mediaType: string;
}

export type FetchBytes = (storageId: string) => Promise<ImageBytes>;

export interface BuildPromptArgs {
  text: string;
  imageStorageIds: string[] | undefined;
  fetchBytes: FetchBytes;
}

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type TextBlock = { type: "text"; text: string };

export type PromptInput = string | Array<ImageBlock | TextBlock>;

export async function buildPromptWithImages(
  args: BuildPromptArgs,
): Promise<PromptInput> {
  const ids = args.imageStorageIds ?? [];
  if (ids.length === 0) return args.text;

  const blocks: Array<ImageBlock | TextBlock> = [];
  for (const id of ids) {
    const { bytes, mediaType } = await args.fetchBytes(id);
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: bytes.toString("base64"),
      },
    });
  }
  blocks.push({ type: "text", text: args.text.length > 0 ? args.text : "(image)" });
  return blocks;
}
```

- [ ] **Step 9.4: Run tests, confirm content-block tests pass**

```bash
cd /opt/boop-agent && npm test
```

Expected: 6 content-block tests pass.

- [ ] **Step 9.5: Add `fetchStoredBytes` helper used at runtime**

In `server/images/content-blocks.ts`, append:

```ts
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

export async function fetchStoredBytes(storageId: string): Promise<ImageBytes> {
  const url = await convex.query(api.messages.getStorageUrl, {
    storageId: storageId as never,
  });
  if (!url) throw new Error(`image storage missing: ${storageId}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mediaType: ct };
}
```

- [ ] **Step 9.6: Extend `HandleOpts` and consume images in the dispatcher**

In `server/interaction-agent.ts`, find the `HandleOpts` interface (around line 170-179). Replace it with:

```ts
interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  kind?: "user" | "proactive";
  images?: Array<{ storageId: string; mediaType: string }>;
  mediaError?: string;
}
```

Add the import near the top of the file (after the existing imports around line 14):

```ts
import { buildPromptWithImages, fetchStoredBytes } from "./images/content-blocks.js";
```

Find the line that inserts the user message into Convex (around line 190-195) and pass image fields:

Old:
```ts
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
  });
```

New:
```ts
  const inboundImageStorageIds = (opts.images ?? []).map((i) => i.storageId);
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
    imageStorageIds: inboundImageStorageIds.length > 0
      ? (inboundImageStorageIds as never)
      : undefined,
    mediaError: opts.mediaError,
  });
```

Then find the `const prompt = historyBlock ? ... : opts.content;` line (around line 301). Replace it with:

```ts
  const userText = opts.mediaError
    ? `[user sent images but they couldn't be downloaded: ${opts.mediaError}]\n${opts.content}`
    : opts.content;
  const promptBody = await buildPromptWithImages({
    text: historyBlock
      ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${userText}`
      : userText,
    imageStorageIds: inboundImageStorageIds,
    fetchBytes: fetchStoredBytes,
  });
```

Then change the `query({ prompt, options: ... })` call to use `promptBody`:

Old:
```ts
    for await (const msg of query({
      prompt,
      options: {
```

New:
```ts
    for await (const msg of query({
      prompt: promptBody,
      options: {
```

- [ ] **Step 9.7: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 9.8: Run tests**

```bash
cd /opt/boop-agent && npm test
```

Expected: all tests pass.

- [ ] **Step 9.9: Commit Task 8 + Task 9 together**

```bash
cp /opt/boop-agent/convex/messages.ts /tmp/boop-agent-pr/convex/messages.ts && \
cp /opt/boop-agent/server/sendblue.ts /tmp/boop-agent-pr/server/sendblue.ts && \
cp /opt/boop-agent/server/images/content-blocks.ts /tmp/boop-agent-pr/server/images/content-blocks.ts && \
cp /opt/boop-agent/server/interaction-agent.ts /tmp/boop-agent-pr/server/interaction-agent.ts && \
cp /opt/boop-agent/test/content-blocks.test.ts /tmp/boop-agent-pr/test/content-blocks.test.ts && \
cd /tmp/boop-agent-pr && git add convex/messages.ts server/sendblue.ts server/images/content-blocks.ts server/interaction-agent.ts test/content-blocks.test.ts && \
git commit -m "$(cat <<'EOF'
feat(images): ingest MMS attachments and feed them to the dispatcher

Sendblue webhook handler downloads media URLs, validates MIME +
size, uploads bytes to Convex storage, and stores storageIds on the
message row. The dispatcher's SDK call switches from a plain string
prompt to an Anthropic content array (image blocks + final text)
whenever the inbound turn has imageStorageIds. mediaError surfaces
to the dispatcher as a prepended note when download fails so the
model can tell the user what went wrong.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Propagate images to execution agents

### Task 10: `spawn_agent` gains `imageRefs`, execution agent prepends image blocks

**Files:**
- Modify: `server/interaction-agent.ts` (spawn_agent tool definition)
- Modify: `server/execution-agent.ts` (`spawnExecutionAgent` accepts image refs, prepends blocks)
- Test: `test/content-blocks.test.ts` already covers the builder; we'll only need to verify the new path manually

- [ ] **Step 10.1: Extend `spawnExecutionAgent` signature**

In `server/execution-agent.ts`, find the `spawnExecutionAgent` declaration (around line 80). Read the existing `SpawnExecutionAgentOpts` (or whatever it's called); extend it with `imageStorageIds?: string[]`. If no interface exists yet, locate the inline arg list and replace with:

```ts
export interface SpawnExecutionAgentOpts {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  imageStorageIds?: string[];
}

export async function spawnExecutionAgent(
  opts: SpawnExecutionAgentOpts,
): Promise<SpawnResult> {
```

(If `SpawnResult` doesn't exist yet, add it next to the interface:
```ts
export interface SpawnResult {
  agentId: string;
  result: string;
  status: "completed" | "failed" | "cancelled";
}
```
The existing return statements `return { agentId, result, status }` already match this shape.)

- [ ] **Step 10.2: Prepend image blocks to the execution agent's prompt**

Still in `server/execution-agent.ts`, near the top add:

```ts
import { buildPromptWithImages, fetchStoredBytes } from "./images/content-blocks.js";
```

Find the `for await (const msg of query({ prompt: opts.task, options: {...} }))` block (around line 163). Just before this `for` loop, add:

```ts
  const executionPrompt = await buildPromptWithImages({
    text: opts.task,
    imageStorageIds: opts.imageStorageIds,
    fetchBytes: fetchStoredBytes,
  });
```

Then change `prompt: opts.task` to `prompt: executionPrompt`.

Also handle `retryAgent` and `availableIntegrations` — `retryAgent` re-spawns from a stored row. It does not currently know about image refs; that's fine for V1 (retries lose the image context). Leave `retryAgent` as-is and document in a comment:

In `retryAgent` around line 294, add a comment line right above `return await spawnExecutionAgent({...})`:

```ts
  // V1 limitation: image refs are not persisted to executionAgents and
  // therefore are not replayed on retry. Re-trigger from the original
  // turn if you need the image inputs.
```

- [ ] **Step 10.3: Add `imageRefs` to the `spawn_agent` tool schema in interaction-agent**

In `server/interaction-agent.ts`, find the `spawn_agent` tool definition (around lines 255-285). Replace the tool block with:

```ts
      tool(
        "spawn_agent",
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for anything requiring lookups, drafting, or actions in the user's integrations. If the current user message includes images and the sub-agent's task depends on them, pass the relevant storage IDs in imageRefs.",
        {
          task: z
            .string()
            .describe("Crisp task description — what to find/draft/do, not the raw user message."),
          integrations: z
            .array(z.string())
            .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
          name: z.string().optional().describe("Short label for the agent."),
          imageRefs: z
            .array(z.string())
            .optional()
            .describe("Convex storage IDs from the user's current message. Available in this turn: " +
              (inboundImageStorageIdsForPrompt.length > 0 ? inboundImageStorageIdsForPrompt.join(", ") : "(none)")),
        },
        async (args) => {
          const res = await spawnExecutionAgent({
            task: args.task,
            integrations: args.integrations,
            conversationId: opts.conversationId,
            name: args.name,
            imageStorageIds: args.imageRefs,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `[agent ${res.agentId} ${res.status}]\n\n${res.result}`,
              },
            ],
          };
        },
      ),
```

`inboundImageStorageIdsForPrompt` is computed below. Earlier in the same function (right after `const inboundImageStorageIds = (opts.images ?? []).map(...)` from Task 9), add:

```ts
  const inboundImageStorageIdsForPrompt = inboundImageStorageIds;
```

This keeps the variable in scope of the tool factory closure where the dispatcher's prompt sees it.

- [ ] **Step 10.4: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 10.5: Run tests**

```bash
cd /opt/boop-agent && npm test
```

Expected: all tests pass (no new tests, but no regressions).

- [ ] **Step 10.6: Commit**

```bash
cp /opt/boop-agent/server/execution-agent.ts /tmp/boop-agent-pr/server/execution-agent.ts && \
cp /opt/boop-agent/server/interaction-agent.ts /tmp/boop-agent-pr/server/interaction-agent.ts && \
cd /tmp/boop-agent-pr && git add server/execution-agent.ts server/interaction-agent.ts && \
git commit -m "$(cat <<'EOF'
feat(spawn-agent): support imageRefs propagation to execution agents

The dispatcher's spawn_agent tool gains an optional imageRefs
parameter (Convex storage IDs). The dispatcher prompt advertises
which IDs are available in the current turn. spawnExecutionAgent
prepends image content blocks to the execution agent's prompt when
imageRefs is set.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Patch dispatcher system prompt to advertise image handling

**Files:**
- Modify: `server/interaction-agent.ts` (the `INTERACTION_SYSTEM` template)

- [ ] **Step 11.1: Add image guidance to the dispatcher system prompt**

In `server/interaction-agent.ts`, find the `Format:` line near the bottom of `INTERACTION_SYSTEM` (around line 168). Just above it, add:

```
Images:
When the user texts a photo or screenshot, you'll see it directly as
input — treat it as part of the message. Describe it, answer questions
about it, or extract info from it the same way you'd handle text. If
the user's request depends on the image AND requires a sub-agent (e.g.
"search the web for this product I'm photographing"), pass the relevant
storage IDs to spawn_agent's imageRefs parameter so the sub-agent can
see the image too. If the user sends a photo with no caption, ask a
short clarifying question rather than guessing what they want.

```

- [ ] **Step 11.2: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 11.3: Commit**

```bash
cp /opt/boop-agent/server/interaction-agent.ts /tmp/boop-agent-pr/server/interaction-agent.ts && \
cd /tmp/boop-agent-pr && git add server/interaction-agent.ts && \
git commit -m "$(cat <<'EOF'
feat(interaction-agent): document image handling in dispatcher prompt

Teaches the dispatcher to treat inbound images as first-class input
and to route imageRefs through spawn_agent when the sub-agent needs
to see the image too.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 8 — Memory extraction with images

### Task 12: Extraction sees images and can write image-anchored memory records

**Files:**
- Modify: `server/memory/extract.ts`
- Modify: `convex/memoryRecords.ts` (extend `upsert` mutation args)

- [ ] **Step 12.1: Extend `memoryRecords.upsert` to accept `imageStorageIds`**

In `convex/memoryRecords.ts`, find the `upsert` mutation. Read the file end-to-end first to locate it; then add `imageStorageIds: v.optional(v.array(v.id("_storage")))` to the `args` block, and propagate it into the `ctx.db.insert` / `ctx.db.patch` calls. The exact patch depends on the file's current shape, but the canonical insert call should become:

```ts
await ctx.db.insert("memoryRecords", {
  // ...existing fields,
  ...(args.imageStorageIds && args.imageStorageIds.length > 0
    ? { imageStorageIds: args.imageStorageIds }
    : {}),
});
```

And the matching patch call should add the same conditional spread. Do not include the field unless non-empty — keeps rows clean.

- [ ] **Step 12.2: Push schema/mutations to dev Convex**

```bash
cd /opt/boop-agent && npx convex dev --once 2>&1 | tail -10
```

Expected: 0 errors; generated API reflects the new arg.

- [ ] **Step 12.3: Extend extraction to receive images and emit image-anchored records**

In `server/memory/extract.ts`, change the `extractAndStore` signature to accept image refs and pass them to the model. Replace the function declaration through to the `query` call (lines 40-67):

```ts
export async function extractAndStore(opts: {
  conversationId: string;
  userMessage: string;
  assistantReply: string;
  turnId: string;
  imageStorageIds?: string[];
}): Promise<void> {
  const started = Date.now();
  const requestedModel = process.env.BOOP_MODEL ?? "claude-sonnet-4-6";
  try {
    const payload: Parameters<typeof query>[0]["prompt"] =
      opts.imageStorageIds && opts.imageStorageIds.length > 0
        ? await buildPromptWithImages({
            text: `USER: ${opts.userMessage}\n\nASSISTANT: ${opts.assistantReply}`,
            imageStorageIds: opts.imageStorageIds,
            fetchBytes: fetchStoredBytes,
          })
        : `USER: ${opts.userMessage}\n\nASSISTANT: ${opts.assistantReply}`;
    let buffer = "";
    let usage: UsageTotals = { ...EMPTY_USAGE };
    for await (const msg of query({
      prompt: payload,
      options: {
        systemPrompt: EXTRACTION_PROMPT,
        model: requestedModel,
        permissionMode: "bypassPermissions",
      },
    })) {
```

Note: `Parameters<typeof query>[0]["prompt"]` reuses the SDK's own type for the prompt union. This works because we already import `query` from the SDK.

Add the new import at the top of the file:

```ts
import { buildPromptWithImages, fetchStoredBytes } from "../images/content-blocks.js";
```

- [ ] **Step 12.4: Expand the extraction prompt to ask for image-anchored facts**

In the same file, replace the `EXTRACTION_PROMPT` template literal (lines 8-31) with:

```ts
const EXTRACTION_PROMPT = `You are a memory-extraction subagent.

Given a user message + assistant reply (and, sometimes, an image the
user sent), extract any DURABLE facts worth remembering.

Return STRICT JSON:
{"facts":[
  {"content":"...","segment":"identity|preference|correction|relationship|project|knowledge|context","importance":0.0-1.0,"corrects":"what was wrong, if this is a correction","describesImage":true|false}
]}

Rules:
- Prefer fewer, higher-quality facts over many trivial ones.
- Skip anything transient ("I'm tired right now"). Context facts should describe ongoing state, not momentary feelings.
- If the user sent an image and it depicts something durable (a pet, a place they live, a project they're working on, a vehicle they own, a document they reference), produce a SINGLE descriptive fact for that image. content: "User sent a photo: <one-sentence factual description>". segment: knowledge (or relationship for people, project for projects). describesImage: true.
- Skip image-description for fleeting screenshots ("here's the receipt from today") — those are context at best, and 3-day cleanup will reclaim them.
- Segment meanings:
  - identity: name, role, location, core traits (highest priority — rarely changes)
  - correction: the user explicitly corrected something. "No, it's Sarah not Sara." "Actually I prefer X not Y." Set "corrects" to the wrong value or prior belief being overturned. Use this instead of preference/identity when the user is FIXING something rather than stating it fresh.
  - preference: how they like things done (style, defaults)
  - relationship: people they know + how
  - project: ongoing work or goals
  - knowledge: facts about their world
  - context: current ongoing situation
- Importance defaults: identity 0.85, correction 0.80, relationship 0.75, preference 0.70, project 0.65, knowledge 0.60, context 0.40. Bump up or down only when you have a clear reason — trust the defaults.
- The "corrects" field is ONLY for segment="correction". Omit it (or null) for everything else.
- The "describesImage" field is true ONLY for the one fact (if any) that describes the inbound image. Omit it (or false) for all other facts.
- Return empty facts array if nothing durable.

Respond with ONLY the JSON object.`;
```

- [ ] **Step 12.5: Attach `imageStorageIds` to image-anchored memory records**

In the `for (const f of facts)` loop in extract.ts (around line 89), update the `ctx.db.insert` call args. Locate the existing `await convex.mutation(api.memoryRecords.upsert, {...})` block (lines 104-114) and replace with:

```ts
      const isImageDescription =
        Boolean((f as { describesImage?: boolean }).describesImage) &&
        opts.imageStorageIds &&
        opts.imageStorageIds.length > 0;
      await convex.mutation(api.memoryRecords.upsert, {
        memoryId,
        content: f.content,
        tier: defaults.tier,
        segment: f.segment,
        importance: rawImportance,
        decayRate: defaults.decayRate,
        sourceTurn: opts.turnId,
        embedding,
        metadata,
        imageStorageIds: isImageDescription
          ? (opts.imageStorageIds as never)
          : undefined,
      });
```

Also extend the `ExtractedFact` interface:

```ts
interface ExtractedFact {
  content: string;
  segment: MemorySegment;
  importance: number;
  corrects?: string | null;
  describesImage?: boolean;
}
```

- [ ] **Step 12.6: Pass image storage IDs from the dispatcher into extraction**

In `server/interaction-agent.ts`, find the call site for `extractAndStore` (it's somewhere after the SDK loop finishes — search for `extractAndStore(`). Add the `imageStorageIds` field to the args:

```ts
  void extractAndStore({
    conversationId: opts.conversationId,
    userMessage: opts.content,
    assistantReply: reply,
    turnId,
    imageStorageIds: inboundImageStorageIds,
  });
```

- [ ] **Step 12.7: Typecheck and test**

```bash
cd /opt/boop-agent && npm run typecheck && npm test
```

Expected: 0 errors, all tests pass.

- [ ] **Step 12.8: Commit**

```bash
cp /opt/boop-agent/server/memory/extract.ts /tmp/boop-agent-pr/server/memory/extract.ts && \
cp /opt/boop-agent/server/interaction-agent.ts /tmp/boop-agent-pr/server/interaction-agent.ts && \
cp /opt/boop-agent/convex/memoryRecords.ts /tmp/boop-agent-pr/convex/memoryRecords.ts && \
cd /tmp/boop-agent-pr && git add server/memory/extract.ts server/interaction-agent.ts convex/memoryRecords.ts && \
git commit -m "$(cat <<'EOF'
feat(memory): image-aware extraction with image-anchored records

The extraction Haiku now receives the inbound image alongside the
USER/ASSISTANT text and may emit a single image-descriptive memory
record per turn. memoryRecords.imageStorageIds points back to the
original image so 'remember the photo I sent yesterday' can recall
the right one and so the cleanup job knows the image is anchored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 9 — Image cleanup job

### Task 13: Periodic cleanup of expired image bytes

**Files:**
- Create: `server/images/clean.ts`
- Modify: `server/index.ts` (register the periodic interval)
- Modify: `convex/messages.ts` (query: list expired image-bearing messages)
- Modify: `convex/memoryRecords.ts` (query: is any record referencing a given storageId)

- [ ] **Step 13.1: Add Convex query: `messages.expiredWithImages`**

In `convex/messages.ts`, append:

```ts
export const expiredWithImages = query({
  args: { olderThanMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = args.olderThanMs;
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .order("asc")
      .take(args.limit ?? 200);
    return rows.filter(
      (r) => Array.isArray(r.imageStorageIds) && r.imageStorageIds.length > 0,
    );
  },
});

export const clearMessageImage = mutation({
  args: { messageId: v.id("messages"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.messageId);
    if (!row || !row.imageStorageIds) return;
    const remaining = row.imageStorageIds.filter((id) => id !== args.storageId);
    if (remaining.length === 0) {
      await ctx.db.patch(args.messageId, { imageStorageIds: undefined });
    } else {
      await ctx.db.patch(args.messageId, { imageStorageIds: remaining });
    }
  },
});

export const deleteImageBytes = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId);
  },
});
```

- [ ] **Step 13.2: Add Convex query: `memoryRecords.hasImageRef`**

In `convex/memoryRecords.ts`, append:

```ts
export const hasImageRef = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    // Linear scan is fine while memory volume is small; for large user
    // bases, add an index on imageStorageIds via a secondary join table.
    const all = await ctx.db.query("memoryRecords").collect();
    return all.some(
      (r) =>
        Array.isArray(r.imageStorageIds) &&
        r.imageStorageIds.includes(args.storageId),
    );
  },
});
```

- [ ] **Step 13.3: Push to dev Convex**

```bash
cd /opt/boop-agent && npx convex dev --once 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 13.4: Create the cleanup module**

Create `server/images/clean.ts`:

```ts
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

const DEFAULT_RETENTION_DAYS = 3;

export function getImageRetentionDays(): number {
  const raw = process.env.BOOP_IMAGE_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

export async function runImageCleanup(): Promise<{ deleted: number; kept: number }> {
  const retention = getImageRetentionDays();
  if (retention === 0) return { deleted: 0, kept: 0 };

  const olderThanMs = Date.now() - retention * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;

  const batch = await convex.query(api.messages.expiredWithImages, {
    olderThanMs,
    limit: 200,
  });
  for (const msg of batch) {
    const ids = (msg.imageStorageIds ?? []) as string[];
    for (const storageId of ids) {
      const anchored = await convex.query(api.memoryRecords.hasImageRef, {
        storageId: storageId as never,
      });
      if (anchored) {
        kept++;
        continue;
      }
      await convex.mutation(api.messages.deleteImageBytes, {
        storageId: storageId as never,
      });
      await convex.mutation(api.messages.clearMessageImage, {
        messageId: msg._id,
        storageId: storageId as never,
      });
      deleted++;
    }
  }

  return { deleted, kept };
}

export function startImageCleanup(): () => void {
  if (getImageRetentionDays() === 0) {
    console.log("[image-cleanup] disabled (BOOP_IMAGE_RETENTION_DAYS=0)");
    return () => undefined;
  }
  const intervalMs = Number(
    process.env.BOOP_IMAGE_CLEANUP_INTERVAL_MS ?? 12 * 60 * 60 * 1000,
  );
  console.log(
    `[image-cleanup] enabled (retention=${getImageRetentionDays()}d, interval=${intervalMs}ms)`,
  );
  const tick = async () => {
    try {
      const r = await runImageCleanup();
      if (r.deleted > 0 || r.kept > 0) {
        console.log(`[image-cleanup] deleted=${r.deleted} kept=${r.kept}`);
      }
    } catch (err) {
      console.warn("[image-cleanup] tick failed", err);
    }
  };
  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
```

- [ ] **Step 13.5: Wire the cleanup into `server/index.ts`**

Read `server/index.ts` to find where other background tasks are started (e.g., `startSendbluePoller()`). Add right next to it:

```ts
import { startImageCleanup } from "./images/clean.js";
```

And in the boot block, alongside the existing `startSendbluePoller()` call:

```ts
startImageCleanup();
```

- [ ] **Step 13.6: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 13.7: Commit**

```bash
cp /opt/boop-agent/server/images/clean.ts /tmp/boop-agent-pr/server/images/clean.ts && \
cp /opt/boop-agent/server/index.ts /tmp/boop-agent-pr/server/index.ts && \
cp /opt/boop-agent/convex/messages.ts /tmp/boop-agent-pr/convex/messages.ts && \
cp /opt/boop-agent/convex/memoryRecords.ts /tmp/boop-agent-pr/convex/memoryRecords.ts && \
cd /tmp/boop-agent-pr && git add server/images/clean.ts server/index.ts convex/messages.ts convex/memoryRecords.ts && \
git commit -m "$(cat <<'EOF'
feat(images): periodic cleanup of expired image bytes

A background interval scans messages older than
BOOP_IMAGE_RETENTION_DAYS (default 3) with non-empty imageStorageIds
and deletes the storage entries for IDs not referenced by any memory
record. Memory-anchored images survive indefinitely. Setting
BOOP_IMAGE_RETENTION_DAYS=0 disables cleanup entirely (debug only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 10 — Dashboard surfaces

### Task 14: Dashboard stat: image storage count + bytes

**Files:**
- Modify: `convex/dashboard.ts` (add a query for image-storage stats)
- Modify: `debug/src/...` Dashboard tab to render the stat

- [ ] **Step 14.1: Inspect the existing dashboard query shape**

```bash
cat /opt/boop-agent/convex/dashboard.ts | head -80
```

Note the existing export names and arg shapes so the new query follows the same convention.

- [ ] **Step 14.2: Add image-stats query**

In `convex/dashboard.ts`, append:

```ts
export const imageStorageStats = query({
  args: {},
  handler: async (ctx) => {
    const msgs = await ctx.db.query("messages").collect();
    const seen = new Set<string>();
    let count = 0;
    for (const m of msgs) {
      for (const id of m.imageStorageIds ?? []) {
        if (seen.has(id as unknown as string)) continue;
        seen.add(id as unknown as string);
        count++;
      }
    }
    // Convex does not expose per-file byte counts cheaply; report count
    // only for V1.
    return { count };
  },
});
```

- [ ] **Step 14.3: Push to dev Convex**

```bash
cd /opt/boop-agent && npx convex dev --once 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 14.4: Find the Dashboard tab component**

```bash
grep -rn "imageStorageStats\|Total cost\|tokens" /opt/boop-agent/debug/src/ | head -10
```

Locate the Dashboard tab component. Look for an existing stat tile pattern.

- [ ] **Step 14.5: Render the image stat**

Inside the Dashboard component, add a `useQuery(api.dashboard.imageStorageStats)` call near the existing stat queries, and render a tile alongside the existing ones. The exact JSX depends on the component's layout — match the surrounding tiles' className/structure exactly. Conceptually:

```tsx
const imageStats = useQuery(api.dashboard.imageStorageStats);
// ...
<StatTile
  label="Image storage"
  value={imageStats ? `${imageStats.count} files` : "—"}
/>
```

If `StatTile` isn't a real component in this codebase, inline the JSX with the same structure used by the neighbouring tiles.

- [ ] **Step 14.6: Build the debug bundle**

```bash
cd /opt/boop-agent && npm run build:debug 2>&1 | tail -20
```

Expected: 0 errors.

- [ ] **Step 14.7: Typecheck**

```bash
cd /opt/boop-agent && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 14.8: Commit**

```bash
cp /opt/boop-agent/convex/dashboard.ts /tmp/boop-agent-pr/convex/dashboard.ts && \
# Copy the Dashboard component file(s) you edited:
# (replace <Dashboard.tsx-path> with the actual path you modified)
cp /opt/boop-agent/debug/src/<Dashboard.tsx-path> /tmp/boop-agent-pr/debug/src/<Dashboard.tsx-path> && \
cd /tmp/boop-agent-pr && git add convex/dashboard.ts "debug/src/<Dashboard.tsx-path>" && \
git commit -m "$(cat <<'EOF'
feat(debug): image storage count on the Dashboard tab

Shows total unique image storage IDs across all messages. Byte-size
reporting is deferred until Convex exposes per-file metadata cheaply.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Memory tab thumbnail badge

**Files:**
- Modify: `debug/src/...` Memory tab component
- Add: a `<MemoryImageBadge storageId=... />` element that fetches the storage URL via `api.messages.getStorageUrl` and renders a 48×48 thumbnail with link

- [ ] **Step 15.1: Locate the Memory tab component**

```bash
grep -rn "memoryRecords\|MemoryTab\|MemoryView" /opt/boop-agent/debug/src/ | head -10
```

- [ ] **Step 15.2: Implement and render the badge**

In the Memory component (whichever file currently maps `memoryRecords` to rows), wherever each record is rendered, add (after the body, before/after the segment chip):

```tsx
{Array.isArray(record.imageStorageIds) && record.imageStorageIds.length > 0 && (
  <div className="flex gap-1 mt-1">
    {record.imageStorageIds.map((id) => (
      <MemoryImageBadge key={id} storageId={id} />
    ))}
  </div>
)}
```

Add a sibling component file or inline the component in the same file. Inline version:

```tsx
function MemoryImageBadge({ storageId }: { storageId: string }) {
  const url = useQuery(api.messages.getStorageUrl, { storageId: storageId as Id<"_storage"> });
  if (!url) return <div className="w-12 h-12 bg-neutral-200 rounded" />;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt="image memory"
        className="w-12 h-12 object-cover rounded border border-neutral-300"
      />
    </a>
  );
}
```

(`Id<"_storage">` is imported from `../../convex/_generated/dataModel`. Match the existing import style in the file.)

- [ ] **Step 15.3: Build the debug bundle**

```bash
cd /opt/boop-agent && npm run build:debug 2>&1 | tail -20
```

Expected: 0 errors.

- [ ] **Step 15.4: Commit**

```bash
cp /opt/boop-agent/debug/src/<Memory.tsx-path> /tmp/boop-agent-pr/debug/src/<Memory.tsx-path> && \
cd /tmp/boop-agent-pr && git add "debug/src/<Memory.tsx-path>" && \
git commit -m "$(cat <<'EOF'
feat(debug): thumbnail badge for image-anchored memory records

Memory rows with imageStorageIds now render a 48×48 thumbnail
linked to the full image. Lets the operator quickly verify what
the extractor decided to remember.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 11 — Docs & smoke test

### Task 16: `.env.example` and README crumb

**Files:**
- Modify (or create): `.env.example`

- [ ] **Step 16.1: Append env doc**

Append the following to `.env.example` (create the file if it doesn't exist):

```ini
# --- Filesystem access (optional) ---
# off      = no FS tools on any agent (default)
# sandbox  = agents get FS tools scoped to BOOP_WORKSPACE_DIR
# full     = legacy "VPS-wide" Claude Code preset (existing behavior)
BOOP_VPS_FILESYSTEM_ACCESS=off
# Workspace root used when BOOP_VPS_FILESYSTEM_ACCESS=sandbox.
# Created automatically if missing. Default: ~/boop-workspace
BOOP_WORKSPACE_DIR=

# --- Image retention (optional) ---
# Days to keep iMessage-received image bytes. Images referenced by a
# memory record are kept indefinitely regardless of this setting.
# Set to 0 to disable cleanup (debug only).
BOOP_IMAGE_RETENTION_DAYS=3
BOOP_IMAGE_CLEANUP_INTERVAL_MS=43200000
```

- [ ] **Step 16.2: Commit**

```bash
cp /opt/boop-agent/.env.example /tmp/boop-agent-pr/.env.example && \
cd /tmp/boop-agent-pr && git add .env.example && \
git commit -m "$(cat <<'EOF'
docs: document BOOP_VPS_FILESYSTEM_ACCESS=sandbox + image retention

Adds .env.example entries for BOOP_VPS_FILESYSTEM_ACCESS,
BOOP_WORKSPACE_DIR, BOOP_IMAGE_RETENTION_DAYS, and
BOOP_IMAGE_CLEANUP_INTERVAL_MS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Manual smoke test pass

Run through the checklist from §10 of the spec. This task has no code changes; it is the verification gate before opening the PR for review.

- [ ] **Step 17.1: Set env on the deployment**

```bash
# In .env.local on the live VPS:
BOOP_VPS_FILESYSTEM_ACCESS=sandbox
BOOP_WORKSPACE_DIR=/home/<user>/boop-workspace
BOOP_IMAGE_RETENTION_DAYS=3
```

Restart the server (`npm run dev` or service restart).

- [ ] **Step 17.2: Run automated tests**

```bash
cd /opt/boop-agent && npm test && npm run typecheck
```

Expected: PASS.

- [ ] **Step 17.3: Image smoke tests**

Run smoke tests 1-10 from the spec's §10. Capture in the PR description which ones passed and any deviations.

- [ ] **Step 17.4: Filesystem smoke tests**

Run smoke tests 11-17 from the spec's §10.

- [ ] **Step 17.5: Push final commits and mark PR ready for review**

```bash
cd /tmp/boop-agent-pr && git push
gh pr ready  # if the existing PR was opened as draft
gh pr comment --body "Manual smoke tests passed: <list of passed items>. <note any deviations>"
```

---

## Self-Review

After writing each task, the engineer running this plan should sanity-check before commit:

1. **Spec coverage:** Every numbered section of `2026-05-13-image-and-fs-access-design.md` should map to at least one task.
   - §3 architecture — covered implicitly across tasks
   - §4 config — Task 16
   - §5.1 ingest — Task 8
   - §5.2 dispatcher consume — Task 9
   - §5.3 propagation — Task 10
   - §5.4 memory extraction — Task 12
   - §5.5 schema — Task 6
   - §6.1 workspace module — Task 2
   - §6.2 execution agent FS — Task 3
   - §6.3 interaction agent FS — Tasks 4 + 5
   - §6.4 tool surface table — implicit in Tasks 3 + 4
   - §7 cleanup — Task 13
   - §8 error handling — folded into Task 8 (image errors) and Task 3 (path-guard denial)
   - §9 testing — Tasks 1, 2, 7, 9
   - §10 smoke test — Task 17
   - §11 rollout — Task 16
   - §13 schema migration notes — Task 6 (additive only)

2. **Placeholder scan:** None used (TBD/TODO/implement later are absent). The dashboard JSX placeholders (`<Dashboard.tsx-path>` and `<Memory.tsx-path>`) are sentinels for the engineer to fill in after grepping — they are explicit instructions, not unspecified work.

3. **Type consistency:** `WorkspaceConfig`, `IngestedImage`, `SpawnExecutionAgentOpts`, `HandleOpts.images`, and the content-block builder shape are all referenced consistently across tasks.

---
