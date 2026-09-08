/**
 * Don fork: isParentCwdPath — the pure check behind the worktree_path no-op.
 *
 * A model that fills every optional field sends the parent working directory as
 * worktree_path. That value selects no OTHER worktree, so the caller treats it
 * as a no-op rather than a conflict with session_key.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isParentCwdPath } from "../../src/spawn/worktree-validator.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-cwd-"));
  dirs.push(dir);
  // realpathSync resolves /var to /private/var on macOS, so canonicalize the
  // fixture the same way the function does.
  return fs.realpathSync(dir);
}

describe("isParentCwdPath — real paths", () => {
  it("matches the identical absolute path", () => {
    const cwd = tempDir();
    expect(isParentCwdPath(cwd, cwd)).toBe(true);
  });

  it("matches a trailing slash", () => {
    const cwd = tempDir();
    expect(isParentCwdPath(`${cwd}/`, cwd)).toBe(true);
  });

  it("matches '.' and './'", () => {
    const cwd = tempDir();
    expect(isParentCwdPath(".", cwd)).toBe(true);
    expect(isParentCwdPath("./", cwd)).toBe(true);
  });

  it("matches a relative round trip through a child directory", () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, "sub"));
    expect(isParentCwdPath("sub/..", cwd)).toBe(true);
  });

  it("matches through a symlink to the parent cwd", () => {
    // A worktree deployed as a symlink to the repo is still the same directory.
    const root = tempDir();
    const real = path.join(root, "repo");
    const link = path.join(root, "repo-link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(isParentCwdPath(link, real)).toBe(true);
  });

  it("does not match a sibling directory", () => {
    const root = tempDir();
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    expect(isParentCwdPath(b, a)).toBe(false);
  });

  it("does not match a subdirectory of the parent cwd", () => {
    // A subdirectory is a real, different working directory.
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, "packages"));
    expect(isParentCwdPath("packages", cwd)).toBe(false);
  });

  it("does not match the parent of the parent cwd", () => {
    const root = tempDir();
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    expect(isParentCwdPath("..", child)).toBe(false);
  });
});

describe("isParentCwdPath — degenerate input", () => {
  it("treats an empty or whitespace worktree_path as no match", () => {
    // An empty placeholder is handled earlier as "absent", so this must not
    // report a parent-cwd hit and produce a misleading note.
    expect(isParentCwdPath("", "/repo")).toBe(false);
    expect(isParentCwdPath("   ", "/repo")).toBe(false);
  });

  it("treats an empty parent cwd as no match", () => {
    expect(isParentCwdPath("/repo", "")).toBe(false);
    expect(isParentCwdPath("/repo", "   ")).toBe(false);
  });

  it("falls back to a normalized comparison when neither path exists", () => {
    // realpathSync throws for a missing path; the comparison must still work.
    expect(isParentCwdPath("/nope/repo", "/nope/repo")).toBe(true);
    expect(isParentCwdPath("/nope/repo/", "/nope/repo")).toBe(true);
    expect(isParentCwdPath("/nope/other", "/nope/repo")).toBe(false);
  });
});
