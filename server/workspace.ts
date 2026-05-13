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
