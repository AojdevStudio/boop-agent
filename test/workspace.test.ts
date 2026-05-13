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
