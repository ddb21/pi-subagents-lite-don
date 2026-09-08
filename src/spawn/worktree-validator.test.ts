import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isParentCwdPath } from "./worktree-validator.js";

describe("isParentCwdPath", () => {
  const makeParent = () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-worktree-validator-"));
    const parent = path.join(root, "repo");
    mkdirSync(parent);
    return { root, parent };
  };

  it("matches an absolute parent path", () => {
    const { parent } = makeParent();
    expect(isParentCwdPath(parent, parent)).toBe(true);
  });

  it("resolves a relative path against the parent cwd", () => {
    const { parent } = makeParent();
    expect(isParentCwdPath(".", parent)).toBe(true);
  });

  it("ignores a trailing slash", () => {
    const { parent } = makeParent();
    expect(isParentCwdPath(`${parent}${path.sep}`, parent)).toBe(true);
  });

  it.each(["", "   "])("rejects empty input %j", (input) => {
    const { parent } = makeParent();
    expect(isParentCwdPath(input, parent)).toBe(false);
  });

  it("rejects a different directory", () => {
    const { root, parent } = makeParent();
    const other = path.join(root, "other");
    mkdirSync(other);
    expect(isParentCwdPath(other, parent)).toBe(false);
  });

  it("rejects a non-existent path", () => {
    const { root, parent } = makeParent();
    expect(isParentCwdPath(path.join(root, "missing"), parent)).toBe(false);
  });

  it("matches a symlink alias of the parent cwd", () => {
    const { root, parent } = makeParent();
    const alias = path.join(root, "repo-alias");
    symlinkSync(parent, alias, "dir");
    expect(isParentCwdPath(alias, parent)).toBe(true);
  });
});
