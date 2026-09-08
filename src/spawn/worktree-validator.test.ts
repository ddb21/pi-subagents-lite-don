import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isParentCwdPath } from "./worktree-validator.js";

beforeEach(() => vi.restoreAllMocks());

describe("isParentCwdPath", () => {
  const makeParent = () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-worktree-validator-"));
    const parent = path.join(root, "repo");
    mkdirSync(parent);
    return { root, parent };
  };

  it("covers absolute, relative, trailing slash, empty, different, missing, and symlink paths", () => {
    const { root, parent } = makeParent();
    const other = path.join(root, "other");
    const alias = path.join(root, "repo-alias");
    mkdirSync(other);
    symlinkSync(parent, alias, "dir");

    expect(isParentCwdPath(parent, parent)).toBe(true);
    expect(isParentCwdPath(".", parent)).toBe(true);
    expect(isParentCwdPath(`${parent}${path.sep}`, parent)).toBe(true);
    expect(isParentCwdPath("", parent)).toBe(false);
    expect(isParentCwdPath("   ", parent)).toBe(false);
    expect(isParentCwdPath(other, parent)).toBe(false);
    expect(isParentCwdPath(path.join(root, "missing"), parent)).toBe(false);
    expect(isParentCwdPath(alias, parent)).toBe(true);
  });
});
