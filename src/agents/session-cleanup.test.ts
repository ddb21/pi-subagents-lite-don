import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCleanup, expireTrash, globToRegExp, type CleanupOptions } from "./session-cleanup.js";
import { getSubagentSessionDir, getSessionKeyIndexFile, recordSessionKey } from "./persistent-executor.js";

const DAY_MS = 86_400_000;

let root: string;
let agentDir: string;
let subDir: string;
let trashDir: string;

function baseOpts(over: Partial<CleanupOptions> = {}): CleanupOptions {
  return {
    agentDirs: [agentDir],
    retentionDays: 14,
    keepGlobs: [],
    apply: true,
    includeMain: false,
    mainRetentionDays: 30,
    trashDir,
    trashRetentionDays: 7,
    now: Date.now(),
    ...over,
  };
}

function writeTranscript(name: string, ageDays: number, now: number): string {
  const file = path.join(subDir, name);
  fs.writeFileSync(file, `{"type":"message"}\n`, "utf8");
  const t = (now - ageDays * DAY_MS) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-"));
  agentDir = path.join(root, ".pi/agent");
  subDir = getSubagentSessionDir(agentDir);
  trashDir = path.join(root, ".pi-cleanup/trash");
  fs.mkdirSync(subDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("matches * and ? and escapes regex metachars", () => {
    expect(globToRegExp("exec-*").test("exec-foo")).toBe(true);
    expect(globToRegExp("exec-*").test("scout-foo")).toBe(false);
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("runCleanup - stale transcript quarantine", () => {
  it("quarantines an old unreferenced transcript and leaves recent ones", () => {
    const now = Date.now();
    const old = writeTranscript("old.jsonl", 30, now);
    const recent = writeTranscript("recent.jsonl", 2, now);

    const res = runCleanup(baseOpts({ now }));

    expect(res.ok).toBe(true);
    expect(fs.existsSync(old)).toBe(false); // moved to trash
    expect(fs.existsSync(recent)).toBe(true);
    expect(res.perDir[0].quarantinedTranscripts).toContain(path.resolve(old));

    // Restore manifest exists and references the moved file.
    const dateDir = fs.readdirSync(trashDir)[0];
    const manifest = fs.readFileSync(path.join(trashDir, dateDir, "manifest.jsonl"), "utf8");
    expect(manifest).toContain(path.resolve(old));
  });
});

describe("runCleanup - referenced protection", () => {
  it("never quarantines a transcript referenced by a live index entry, even if ancient", () => {
    const now = Date.now();
    const ancient = writeTranscript("ancient.jsonl", 999, now);
    recordSessionKey(agentDir, root, "executor", "exec-keep", ancient);

    const res = runCleanup(baseOpts({ now }));

    expect(res.ok).toBe(true);
    expect(fs.existsSync(ancient)).toBe(true);
    expect(res.perDir[0].quarantinedTranscripts).toHaveLength(0);
    expect(res.perDir[0].referencedCount).toBe(1);
  });
});

describe("runCleanup - orphan index pruning", () => {
  it("removes index entries whose transcript file is gone and records them", () => {
    const now = Date.now();
    const missing = path.join(subDir, "gone.jsonl");
    recordSessionKey(agentDir, root, "executor", "exec-orphan", missing); // file never created

    const res = runCleanup(baseOpts({ now }));

    expect(res.ok).toBe(true);
    expect(res.perDir[0].orphanIndexRemoved.length).toBe(1);
    const idx = JSON.parse(fs.readFileSync(getSessionKeyIndexFile(agentDir), "utf8"));
    expect(Object.keys(idx)).toHaveLength(0);
  });
});

describe("runCleanup - keep glob", () => {
  it("preserves a stale transcript matching a keep glob", () => {
    const now = Date.now();
    const keep = writeTranscript("keepme-special.jsonl", 90, now);

    const res = runCleanup(baseOpts({ now, keepGlobs: ["keepme-*"] }));

    expect(fs.existsSync(keep)).toBe(true);
    expect(res.perDir[0].quarantinedTranscripts).toHaveLength(0);
    expect(res.perDir[0].keptByGlob).toBeGreaterThanOrEqual(1);
  });
});

describe("runCleanup - dry run", () => {
  it("makes no filesystem changes and reports what would happen", () => {
    const now = Date.now();
    const old = writeTranscript("old.jsonl", 30, now);
    const missing = path.join(subDir, "gone.jsonl");
    recordSessionKey(agentDir, root, "executor", "exec-orphan", missing);

    const res = runCleanup(baseOpts({ now, apply: false }));

    expect(res.dryRun).toBe(true);
    expect(fs.existsSync(old)).toBe(true); // untouched
    expect(res.perDir[0].quarantinedTranscripts).toContain(path.resolve(old));
    expect(res.perDir[0].orphanIndexRemoved).toHaveLength(1);
    // index NOT mutated in dry-run
    const idx = JSON.parse(fs.readFileSync(getSessionKeyIndexFile(agentDir), "utf8"));
    expect(Object.keys(idx)).toHaveLength(1);
    expect(fs.existsSync(trashDir)).toBe(false);
  });
});

describe("runCleanup - fail-closed on corrupt index", () => {
  it("aborts destructive actions and reports not-ok when the index is corrupt", () => {
    const now = Date.now();
    const old = writeTranscript("old.jsonl", 30, now);
    fs.writeFileSync(getSessionKeyIndexFile(agentDir), "{ this is not json", "utf8");

    const res = runCleanup(baseOpts({ now }));

    expect(res.ok).toBe(false);
    expect(fs.existsSync(old)).toBe(true); // nothing deleted
    expect(res.perDir[0].errors.join(" ")).toMatch(/unreadable index/);
  });
});

describe("runCleanup - include-main", () => {
  it("quarantines stale main sessions only when --include-main is set", () => {
    const now = Date.now();
    const mainDir = path.join(agentDir, "sessions", "2026-01");
    fs.mkdirSync(mainDir, { recursive: true });
    const oldMain = path.join(mainDir, "s.jsonl");
    fs.writeFileSync(oldMain, "{}\n", "utf8");
    const t = (now - 60 * DAY_MS) / 1000;
    fs.utimesSync(oldMain, t, t);

    const off = runCleanup(baseOpts({ now, includeMain: false }));
    expect(fs.existsSync(oldMain)).toBe(true);
    expect(off.perDir[0].quarantinedMainSessions).toHaveLength(0);

    const on = runCleanup(baseOpts({ now, includeMain: true }));
    expect(fs.existsSync(oldMain)).toBe(false);
    expect(on.perDir[0].quarantinedMainSessions).toContain(path.resolve(oldMain));
  });
});

describe("runCleanup - include-main referenced protection", () => {
  it("never quarantines a main-tree transcript referenced by the index, even if ancient", () => {
    const now = Date.now();
    const mainDir = path.join(agentDir, "sessions", "2026-01");
    fs.mkdirSync(mainDir, { recursive: true });
    const oldMain = path.join(mainDir, "host.jsonl");
    fs.writeFileSync(oldMain, "{}\n", "utf8");
    const t = (now - 400 * DAY_MS) / 1000;
    fs.utimesSync(oldMain, t, t);
    // An index entry that (unusually) points into the main tree must still protect it.
    recordSessionKey(agentDir, root, "executor", "exec-host", oldMain);

    const res = runCleanup(baseOpts({ now, includeMain: true }));

    expect(res.ok).toBe(true);
    expect(fs.existsSync(oldMain)).toBe(true);
    expect(res.perDir[0].quarantinedMainSessions).toHaveLength(0);
  });
});

describe("expireTrash", () => {
  it("hard-deletes only trash date-dirs older than retention", () => {
    const now = Date.now();
    const oldDate = new Date(now - 30 * DAY_MS);
    const stamp = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, "0")}-${String(
      oldDate.getDate(),
    ).padStart(2, "0")}`;
    const freshStamp = `${new Date(now).getFullYear()}-01-01x`; // non-date name -> ignored
    fs.mkdirSync(path.join(trashDir, stamp, "sub"), { recursive: true });
    fs.writeFileSync(path.join(trashDir, stamp, "sub", "f.jsonl"), "x", "utf8");
    fs.mkdirSync(path.join(trashDir, freshStamp), { recursive: true });

    const res = expireTrash(trashDir, 7, true, now);

    expect(res.expiredDirs).toContain(stamp);
    expect(fs.existsSync(path.join(trashDir, stamp))).toBe(false);
    expect(fs.existsSync(path.join(trashDir, freshStamp))).toBe(true); // not a date dir
  });
});
