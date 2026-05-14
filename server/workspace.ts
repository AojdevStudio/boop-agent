import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

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
      if (existsSync(resolved)) {
        resolved = realpathSync(resolved);
      } else {
        // Walk up to the nearest existing ancestor and canonicalize it so a
        // symlinked parent can't smuggle a not-yet-created file out of root.
        // Without this, `ln -s /etc ws/link` + `Write ws/link/x` would pass
        // the prefix check because `ws/link/x` doesn't exist for realpathSync
        // to dereference.
        const remainder: string[] = [];
        let ancestor = resolved;
        while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
          remainder.unshift(path.basename(ancestor));
          ancestor = path.dirname(ancestor);
        }
        const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
        resolved = remainder.length > 0 ? path.join(realAncestor, ...remainder) : realAncestor;
      }
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

const PATH_GUARDED_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
]);

export function makeWorkspaceCanUseTool(
  isPathInWorkspace: (p: string) => boolean,
  workspaceRoot: string,
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (!PATH_GUARDED_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    // Glob/Grep can carry BOTH a `path` (search root) AND a `pattern`. Check
    // every path-shaped field — picking just the first match lets a hostile
    // model pass a workspace `path` plus a `/etc/**` `pattern` through.
    for (const key of ["path", "file_path", "pattern"] as const) {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v !== "string" || v.length === 0) continue;
      if (!isPathInWorkspace(v)) {
        return {
          behavior: "deny",
          message: `path outside workspace: ${v} — workspace is rooted at ${workspaceRoot}`,
        };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}
