// Don fork: quarantine-based cleanup for accumulated keyed subagent session
// state. Never hard-deletes live data. Stale/orphaned transcripts are MOVED to a
// dated trash dir with a restore manifest; only a separate, dumber sweep hard-
// deletes trash that has itself aged out. This keeps every destructive step
// reversible, so a corrupt index or a reset mtime costs a `mv` back, not data.

import fs from "node:fs";
import path from "node:path";
import {
  getSubagentSessionDir,
  getSessionKeyIndexFile,
  readSessionKeyIndexStrict,
  mutateSessionKeyIndex,
  withSessionKeyIndexLock,
} from "./persistent-executor.js";

export interface CleanupOptions {
  /** Agent dirs to clean (e.g. ~/.pi/agent). Each is independent + fail-closed. */
  agentDirs: string[];
  /** Quarantine unreferenced keyed transcripts older than this many days. */
  retentionDays: number;
  /** Glob(s) matched against index key, file basename, or full path -> preserve. */
  keepGlobs: string[];
  /** Move/mutate only when true; otherwise report what WOULD happen. */
  apply: boolean;
  /** Also sweep top-level sessions/ (no index protection; mtime-only, reversible). */
  includeMain: boolean;
  mainRetentionDays: number;
  /** Root of the reversible quarantine area. */
  trashDir: string;
  /** Hard-delete trash date-dirs older than this many days. */
  trashRetentionDays: number;
  /** Injectable clock for tests. */
  now?: number;
}

export interface AgentDirResult {
  agentDir: string;
  ok: boolean;
  scannedTranscripts: number;
  referencedCount: number;
  orphanIndexRemoved: string[];
  quarantinedTranscripts: string[];
  quarantinedMainSessions: string[];
  keptByGlob: number;
  bytesReclaimed: number;
  errors: string[];
}

export interface CleanupResult {
  dryRun: boolean;
  ok: boolean;
  perDir: AgentDirResult[];
  trashExpiredDirs: string[];
  trashBytesFreed: number;
  totals: {
    scannedTranscripts: number;
    orphanIndexRemoved: number;
    quarantinedTranscripts: number;
    quarantinedMainSessions: number;
    bytesReclaimed: number;
  };
}

const DAY_MS = 86_400_000;

/** Minimal glob -> RegExp supporting `*` and `?`. Anchored full match. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matchesAnyGlob(candidates: string[], globs: RegExp[]): boolean {
  return globs.some((re) => candidates.some((c) => re.test(c)));
}

/** YYYY-MM-DD in local time, used to bucket trash and detect expiry. */
export function localDateStamp(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sanitizeLabel(p: string): string {
  return path.resolve(p).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function listJsonl(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name));
}

function listJsonlRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonlRecursive(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

interface QuarantinePlan {
  origPath: string;
  reason: string;
  mtimeMs: number;
  size: number;
}

/**
 * Move a file into the dated trash tree, preserving a label for its origin
 * agent dir + subtree, and append a restore record to that day's manifest.
 * Falls back to copy+unlink when rename crosses a device boundary.
 */
function quarantineFile(
  origPath: string,
  agentDir: string,
  subtree: string,
  reason: string,
  trashDir: string,
  now: number,
): void {
  const date = localDateStamp(now);
  const label = sanitizeLabel(agentDir);
  const rel = path.relative(path.join(agentDir, subtree), origPath);
  const destRoot = path.join(trashDir, date, label, subtree);
  const dest = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Collision-safe: two origins that sanitize to the same label + relpath in the
  // same day must not silently overwrite each other in trash.
  let finalDest = dest;
  for (let i = 1; fs.existsSync(finalDest); i++) finalDest = `${dest}.${i}`;
  try {
    fs.renameSync(origPath, finalDest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(origPath, finalDest);
      fs.unlinkSync(origPath);
    } else {
      throw err;
    }
  }
  const manifest = path.join(trashDir, date, "manifest.jsonl");
  const record =
    JSON.stringify({ ts: new Date(now).toISOString(), origPath, trashPath: finalDest, reason, agentDir }) + "\n";
  fs.appendFileSync(manifest, record, "utf8");
}

function cleanupAgentDir(agentDir: string, opts: CleanupOptions, now: number, keepRes: RegExp[]): AgentDirResult {
  const res: AgentDirResult = {
    agentDir,
    ok: true,
    scannedTranscripts: 0,
    referencedCount: 0,
    orphanIndexRemoved: [],
    quarantinedTranscripts: [],
    quarantinedMainSessions: [],
    keptByGlob: 0,
    bytesReclaimed: 0,
    errors: [],
  };

  const subDir = getSubagentSessionDir(agentDir);
  const indexFile = getSessionKeyIndexFile(agentDir);

  // Fail-closed: a corrupt index aborts destructive work for THIS dir only.
  let index: Record<string, string>;
  try {
    index = readSessionKeyIndexStrict(agentDir);
  } catch (err: unknown) {
    res.ok = false;
    res.errors.push(`unreadable index ${indexFile}: ${(err as Error).message}; skipping destructive actions`);
    return res;
  }

  const referenced = new Set(Object.values(index).map((p) => path.resolve(p)));
  res.referencedCount = referenced.size;

  const transcripts = listJsonl(subDir);
  res.scannedTranscripts = transcripts.length;

  const retentionCutoff = now - opts.retentionDays * DAY_MS;

  // 1) Orphan index entries: value no longer on disk. Removing the mapping is
  //    recorded to the manifest so it is restorable. Keep-globbed keys survive.
  const orphanKeys: string[] = [];
  for (const [key, val] of Object.entries(index)) {
    const resolved = path.resolve(val);
    if (fs.existsSync(resolved)) continue;
    // Match keep-globs against the logical session-key suffix too (index keys are
    // `cwd|type|sessionKey`), so `--keep 'exec-*'` behaves as users expect.
    const keySuffix = key.split("|").pop() ?? key;
    if (matchesAnyGlob([key, keySuffix, path.basename(val), resolved], keepRes)) {
      res.keptByGlob++;
      continue;
    }
    orphanKeys.push(key);
  }

  // 2) Stale, UNREFERENCED transcripts older than retention -> quarantine.
  const stalePlans: QuarantinePlan[] = [];
  for (const file of transcripts) {
    const resolved = path.resolve(file);
    if (referenced.has(resolved)) continue; // never touch a referenced transcript
    if (matchesAnyGlob([path.basename(file), resolved], keepRes)) {
      res.keptByGlob++;
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue; // vanished between readdir and stat -> nothing to do
    }
    if (st.mtimeMs >= retentionCutoff) continue;
    stalePlans.push({ origPath: resolved, reason: "stale-unreferenced", mtimeMs: st.mtimeMs, size: st.size });
  }

  // 3) Optional top-level sessions/ sweep (mtime-only; reversible via trash).
  const mainPlans: QuarantinePlan[] = [];
  if (opts.includeMain) {
    const mainDir = path.join(agentDir, "sessions");
    const mainCutoff = now - opts.mainRetentionDays * DAY_MS;
    for (const file of listJsonlRecursive(mainDir)) {
      const resolved = path.resolve(file);
      // Defense-in-depth: never touch a transcript referenced by a live index
      // entry, even in the main tree (today no index value lives here, but do
      // not rely on directory layout for a hard-safety constraint).
      if (referenced.has(resolved)) continue;
      if (matchesAnyGlob([path.basename(file), resolved], keepRes)) {
        res.keptByGlob++;
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs >= mainCutoff) continue;
      mainPlans.push({ origPath: resolved, reason: "stale-main-session", mtimeMs: st.mtimeMs, size: st.size });
    }
  }

  if (!opts.apply) {
    res.orphanIndexRemoved = orphanKeys;
    res.quarantinedTranscripts = stalePlans.map((p) => p.origPath);
    res.quarantinedMainSessions = mainPlans.map((p) => p.origPath);
    res.bytesReclaimed = [...stalePlans, ...mainPlans].reduce((n, p) => n + p.size, 0);
    return res;
  }

  // Apply orphan-index removal under the real lock (merge-safe with live writers).
  if (orphanKeys.length > 0) {
    try {
      const date = localDateStamp(now);
      fs.mkdirSync(path.join(opts.trashDir, date), { recursive: true });
      const manifest = path.join(opts.trashDir, date, "manifest.jsonl");
      mutateSessionKeyIndex(agentDir, (live) => {
        for (const key of orphanKeys) {
          if (!(key in live)) continue;
          const val = live[key];
          if (fs.existsSync(path.resolve(val))) continue; // regrew since scan: keep
          fs.appendFileSync(
            manifest,
            JSON.stringify({ ts: new Date(now).toISOString(), removedIndexKey: key, value: val, agentDir }) + "\n",
            "utf8",
          );
          delete live[key];
          res.orphanIndexRemoved.push(key);
        }
      });
    } catch (err: unknown) {
      res.ok = false;
      res.errors.push(`orphan-index prune failed: ${(err as Error).message}`);
    }
  }

  // Quarantine stale transcripts. The referenced re-check AND the move happen
  // inside the same held lock, so a concurrent recordSessionKey cannot register
  // this path between the check and the move. A corrupt index throws out of the
  // lock helper and we fail closed for that file.
  for (const plan of stalePlans) {
    try {
      const moved = withSessionKeyIndexLock(agentDir, (live): boolean => {
        const refs = new Set(Object.values(live).map((p) => path.resolve(p)));
        if (refs.has(plan.origPath)) return false;
        if (!fs.existsSync(plan.origPath)) return false;
        quarantineFile(plan.origPath, agentDir, "sessions-subagents", plan.reason, opts.trashDir, now);
        return true;
      });
      if (moved) {
        res.quarantinedTranscripts.push(plan.origPath);
        res.bytesReclaimed += plan.size;
      }
    } catch (err: unknown) {
      res.ok = false;
      res.errors.push(`quarantine failed for ${plan.origPath}: ${(err as Error).message}`);
    }
  }

  for (const plan of mainPlans) {
    try {
      if (!fs.existsSync(plan.origPath)) continue;
      quarantineFile(plan.origPath, agentDir, "sessions", plan.reason, opts.trashDir, now);
      res.quarantinedMainSessions.push(plan.origPath);
      res.bytesReclaimed += plan.size;
    } catch (err: unknown) {
      res.ok = false;
      res.errors.push(`quarantine failed for ${plan.origPath}: ${(err as Error).message}`);
    }
  }

  return res;
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else total += safeSize(full);
  }
  return total;
}

/** Second, dumber sweep: hard-delete trash date-dirs older than retention.
 *  Only ever touches paths inside trashDir. Returns freed bytes + dir names. */
export function expireTrash(
  trashDir: string,
  trashRetentionDays: number,
  apply: boolean,
  now: number,
): { expiredDirs: string[]; bytesFreed: number } {
  const expiredDirs: string[] = [];
  let bytesFreed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(trashDir, { withFileTypes: true });
  } catch {
    return { expiredDirs, bytesFreed };
  }
  const cutoff = now - trashRetentionDays * DAY_MS;
  const trashRoot = path.resolve(trashDir);
  for (const e of entries) {
    // Dirent.isDirectory() is lstat-based, so symlinked date-dirs are skipped
    // (never followed). Only literal YYYY-MM-DD names reach the delete.
    if (!e.isDirectory()) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.name);
    if (!m) continue;
    const dirTs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (dirTs >= cutoff) continue;
    const full = path.join(trashDir, e.name);
    const resolved = path.resolve(full);
    // Containment guard: refuse anything that does not resolve to a direct child
    // of the trash root (belt-and-suspenders against a future looser name regex).
    if (path.dirname(resolved) !== trashRoot) continue;
    try {
      const freed = dirSize(full);
      if (apply) fs.rmSync(full, { recursive: true, force: true });
      bytesFreed += freed;
      expiredDirs.push(e.name);
    } catch {
      // EPERM/EBUSY etc: skip this date-dir, keep the run alive and the health
      // signal intact rather than crashing out of runCleanup.
    }
  }
  return { expiredDirs, bytesFreed };
}

export function runCleanup(opts: CleanupOptions): CleanupResult {
  const now = opts.now ?? Date.now();
  const keepRes = opts.keepGlobs.map(globToRegExp);
  const perDir: AgentDirResult[] = [];
  for (const agentDir of opts.agentDirs) {
    perDir.push(cleanupAgentDir(agentDir, opts, now, keepRes));
  }
  const { expiredDirs, bytesFreed } = expireTrash(opts.trashDir, opts.trashRetentionDays, opts.apply, now);

  const totals = {
    scannedTranscripts: perDir.reduce((n, d) => n + d.scannedTranscripts, 0),
    orphanIndexRemoved: perDir.reduce((n, d) => n + d.orphanIndexRemoved.length, 0),
    quarantinedTranscripts: perDir.reduce((n, d) => n + d.quarantinedTranscripts.length, 0),
    quarantinedMainSessions: perDir.reduce((n, d) => n + d.quarantinedMainSessions.length, 0),
    bytesReclaimed: perDir.reduce((n, d) => n + d.bytesReclaimed, 0),
  };
  const ok = perDir.every((d) => d.ok);
  return { dryRun: !opts.apply, ok, perDir, trashExpiredDirs: expiredDirs, trashBytesFreed: bytesFreed, totals };
}
