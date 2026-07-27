#!/usr/bin/env bun
// @bun

// bin/pi-session-cleanup.ts
import fs3 from "fs";
import os from "os";
import path3 from "path";

// src/agents/session-cleanup.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/agents/persistent-executor.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
var SUBAGENT_SESSION_DIR = "sessions-subagents";
var SESSION_KEY_INDEX_FILE = "session-keys.json";
function getSubagentSessionDir(agentDir) {
  return path.join(agentDir, SUBAGENT_SESSION_DIR);
}
function getSessionKeyIndexFile(agentDir) {
  return path.join(getSubagentSessionDir(agentDir), SESSION_KEY_INDEX_FILE);
}
function readSessionKeyIndexStrict(agentDir) {
  const indexFile = getSessionKeyIndexFile(agentDir);
  let raw;
  try {
    raw = fs.readFileSync(indexFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT")
      return {};
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`invalid session key index (not an object): ${indexFile}`);
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string")
      throw new Error(`invalid session key index (non-string value): ${indexFile}`);
  }
  return parsed;
}
function parseIndex(indexFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error("invalid session key index");
    for (const value of Object.values(parsed))
      if (typeof value !== "string")
        throw new Error("invalid session key index");
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT")
      return {};
    return {};
  }
}
function withIndexFileLock(indexFile, fn) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const lockFile = `${indexFile}.lock`;
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockFile);
        } catch {}
      }
    } catch (err) {
      if (err.code !== "EEXIST" || Date.now() >= deadline)
        throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
function mutateSessionKeyIndex(agentDir, mutate) {
  const indexFile = getSessionKeyIndexFile(agentDir);
  return withIndexFileLock(indexFile, () => {
    const index = parseIndex(indexFile);
    mutate(index);
    const tempFile = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(index) + `
`, "utf8");
    fs.renameSync(tempFile, indexFile);
    return index;
  });
}
function withSessionKeyIndexLock(agentDir, fn) {
  const indexFile = getSessionKeyIndexFile(agentDir);
  return withIndexFileLock(indexFile, () => fn(readSessionKeyIndexStrict(agentDir)));
}

// src/agents/session-cleanup.ts
var DAY_MS = 86400000;
function globToRegExp(glob) {
  let out = "";
  for (const ch of glob) {
    if (ch === "*")
      out += ".*";
    else if (ch === "?")
      out += ".";
    else
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
function matchesAnyGlob(candidates, globs) {
  return globs.some((re) => candidates.some((c) => re.test(c)));
}
function localDateStamp(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function sanitizeLabel(p) {
  return path2.resolve(p).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function safeSize(p) {
  try {
    return fs2.statSync(p).size;
  } catch {
    return 0;
  }
}
function listJsonl(dir) {
  let entries;
  try {
    entries = fs2.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path2.join(dir, e.name));
}
function listJsonlRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = fs2.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path2.join(dir, e.name);
    if (e.isDirectory())
      out.push(...listJsonlRecursive(full));
    else if (e.isFile() && e.name.endsWith(".jsonl"))
      out.push(full);
  }
  return out;
}
function quarantineFile(origPath, agentDir, subtree, reason, trashDir, now) {
  const date = localDateStamp(now);
  const label = sanitizeLabel(agentDir);
  const rel = path2.relative(path2.join(agentDir, subtree), origPath);
  const destRoot = path2.join(trashDir, date, label, subtree);
  const dest = path2.join(destRoot, rel);
  fs2.mkdirSync(path2.dirname(dest), { recursive: true });
  let finalDest = dest;
  for (let i = 1;fs2.existsSync(finalDest); i++)
    finalDest = `${dest}.${i}`;
  try {
    fs2.renameSync(origPath, finalDest);
  } catch (err) {
    if (err.code === "EXDEV") {
      fs2.copyFileSync(origPath, finalDest);
      fs2.unlinkSync(origPath);
    } else {
      throw err;
    }
  }
  const manifest = path2.join(trashDir, date, "manifest.jsonl");
  const record = JSON.stringify({ ts: new Date(now).toISOString(), origPath, trashPath: finalDest, reason, agentDir }) + `
`;
  fs2.appendFileSync(manifest, record, "utf8");
}
function cleanupAgentDir(agentDir, opts, now, keepRes) {
  const res = {
    agentDir,
    ok: true,
    scannedTranscripts: 0,
    referencedCount: 0,
    orphanIndexRemoved: [],
    quarantinedTranscripts: [],
    quarantinedMainSessions: [],
    keptByGlob: 0,
    bytesReclaimed: 0,
    errors: []
  };
  const subDir = getSubagentSessionDir(agentDir);
  const indexFile = getSessionKeyIndexFile(agentDir);
  let index;
  try {
    index = readSessionKeyIndexStrict(agentDir);
  } catch (err) {
    res.ok = false;
    res.errors.push(`unreadable index ${indexFile}: ${err.message}; skipping destructive actions`);
    return res;
  }
  const referenced = new Set(Object.values(index).map((p) => path2.resolve(p)));
  res.referencedCount = referenced.size;
  const transcripts = listJsonl(subDir);
  res.scannedTranscripts = transcripts.length;
  const retentionCutoff = now - opts.retentionDays * DAY_MS;
  const orphanKeys = [];
  for (const [key, val] of Object.entries(index)) {
    const resolved = path2.resolve(val);
    if (fs2.existsSync(resolved))
      continue;
    const keySuffix = key.split("|").pop() ?? key;
    if (matchesAnyGlob([key, keySuffix, path2.basename(val), resolved], keepRes)) {
      res.keptByGlob++;
      continue;
    }
    orphanKeys.push(key);
  }
  const stalePlans = [];
  for (const file of transcripts) {
    const resolved = path2.resolve(file);
    if (referenced.has(resolved))
      continue;
    if (matchesAnyGlob([path2.basename(file), resolved], keepRes)) {
      res.keptByGlob++;
      continue;
    }
    let st;
    try {
      st = fs2.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs >= retentionCutoff)
      continue;
    stalePlans.push({ origPath: resolved, reason: "stale-unreferenced", mtimeMs: st.mtimeMs, size: st.size });
  }
  const mainPlans = [];
  if (opts.includeMain) {
    const mainDir = path2.join(agentDir, "sessions");
    const mainCutoff = now - opts.mainRetentionDays * DAY_MS;
    for (const file of listJsonlRecursive(mainDir)) {
      const resolved = path2.resolve(file);
      if (referenced.has(resolved))
        continue;
      if (matchesAnyGlob([path2.basename(file), resolved], keepRes)) {
        res.keptByGlob++;
        continue;
      }
      let st;
      try {
        st = fs2.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs >= mainCutoff)
        continue;
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
  if (orphanKeys.length > 0) {
    try {
      const date = localDateStamp(now);
      fs2.mkdirSync(path2.join(opts.trashDir, date), { recursive: true });
      const manifest = path2.join(opts.trashDir, date, "manifest.jsonl");
      mutateSessionKeyIndex(agentDir, (live) => {
        for (const key of orphanKeys) {
          if (!(key in live))
            continue;
          const val = live[key];
          if (fs2.existsSync(path2.resolve(val)))
            continue;
          fs2.appendFileSync(manifest, JSON.stringify({ ts: new Date(now).toISOString(), removedIndexKey: key, value: val, agentDir }) + `
`, "utf8");
          delete live[key];
          res.orphanIndexRemoved.push(key);
        }
      });
    } catch (err) {
      res.ok = false;
      res.errors.push(`orphan-index prune failed: ${err.message}`);
    }
  }
  for (const plan of stalePlans) {
    try {
      const moved = withSessionKeyIndexLock(agentDir, (live) => {
        const refs = new Set(Object.values(live).map((p) => path2.resolve(p)));
        if (refs.has(plan.origPath))
          return false;
        if (!fs2.existsSync(plan.origPath))
          return false;
        quarantineFile(plan.origPath, agentDir, "sessions-subagents", plan.reason, opts.trashDir, now);
        return true;
      });
      if (moved) {
        res.quarantinedTranscripts.push(plan.origPath);
        res.bytesReclaimed += plan.size;
      }
    } catch (err) {
      res.ok = false;
      res.errors.push(`quarantine failed for ${plan.origPath}: ${err.message}`);
    }
  }
  for (const plan of mainPlans) {
    try {
      if (!fs2.existsSync(plan.origPath))
        continue;
      quarantineFile(plan.origPath, agentDir, "sessions", plan.reason, opts.trashDir, now);
      res.quarantinedMainSessions.push(plan.origPath);
      res.bytesReclaimed += plan.size;
    } catch (err) {
      res.ok = false;
      res.errors.push(`quarantine failed for ${plan.origPath}: ${err.message}`);
    }
  }
  return res;
}
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs2.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path2.join(dir, e.name);
    if (e.isDirectory())
      total += dirSize(full);
    else
      total += safeSize(full);
  }
  return total;
}
function expireTrash(trashDir, trashRetentionDays, apply, now) {
  const expiredDirs = [];
  let bytesFreed = 0;
  let entries;
  try {
    entries = fs2.readdirSync(trashDir, { withFileTypes: true });
  } catch {
    return { expiredDirs, bytesFreed };
  }
  const cutoff = now - trashRetentionDays * DAY_MS;
  const trashRoot = path2.resolve(trashDir);
  for (const e of entries) {
    if (!e.isDirectory())
      continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.name);
    if (!m)
      continue;
    const dirTs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (dirTs >= cutoff)
      continue;
    const full = path2.join(trashDir, e.name);
    const resolved = path2.resolve(full);
    if (path2.dirname(resolved) !== trashRoot)
      continue;
    try {
      const freed = dirSize(full);
      if (apply)
        fs2.rmSync(full, { recursive: true, force: true });
      bytesFreed += freed;
      expiredDirs.push(e.name);
    } catch {}
  }
  return { expiredDirs, bytesFreed };
}
function runCleanup(opts) {
  const now = opts.now ?? Date.now();
  const keepRes = opts.keepGlobs.map(globToRegExp);
  const perDir = [];
  for (const agentDir of opts.agentDirs) {
    perDir.push(cleanupAgentDir(agentDir, opts, now, keepRes));
  }
  const { expiredDirs, bytesFreed } = expireTrash(opts.trashDir, opts.trashRetentionDays, opts.apply, now);
  const totals = {
    scannedTranscripts: perDir.reduce((n, d) => n + d.scannedTranscripts, 0),
    orphanIndexRemoved: perDir.reduce((n, d) => n + d.orphanIndexRemoved.length, 0),
    quarantinedTranscripts: perDir.reduce((n, d) => n + d.quarantinedTranscripts.length, 0),
    quarantinedMainSessions: perDir.reduce((n, d) => n + d.quarantinedMainSessions.length, 0),
    bytesReclaimed: perDir.reduce((n, d) => n + d.bytesReclaimed, 0)
  };
  const ok = perDir.every((d) => d.ok);
  return { dryRun: !opts.apply, ok, perDir, trashExpiredDirs: expiredDirs, trashBytesFreed: bytesFreed, totals };
}

// bin/pi-session-cleanup.ts
function usage() {
  process.stdout.write([
    "pi-session-cleanup - quarantine stale keyed subagent sessions (reversible)",
    "",
    "Flags:",
    "  --agent-dir <path>        Agent dir to clean (repeatable). Default: $PI_CODING_AGENT_DIR",
    "                            or existing of ~/.pi/agent, ~/.pi-lite/agent.",
    "  --retention-days <n>      Age for unreferenced keyed transcripts (default 14).",
    "  --keep <glob>             Preserve matches (repeatable). Full-match glob (* ?)",
    "                            tested against file basename, full path, index key,",
    "                            and the key's session-key suffix (e.g. 'exec-*').",
    "  --apply                   Perform moves/prunes. Omit for dry-run (default).",
    "  --include-main            Also sweep top-level sessions/ (mtime-only, reversible).",
    "  --main-retention-days <n> Age for main sessions when --include-main (default 30).",
    "  --trash-dir <path>        Quarantine root (default ~/.pi-cleanup/trash).",
    "  --trash-retention-days <n> Hard-delete trash older than this (default 7).",
    "  --json                    Emit JSON result.",
    "  -h, --help                Show this help.",
    ""
  ].join(`
`));
}
function defaultAgentDirs() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.trim())
    return [env.trim()];
  return [path3.join(os.homedir(), ".pi/agent"), path3.join(os.homedir(), ".pi-lite/agent")].filter((d) => fs3.existsSync(d));
}
function parseArgs(argv) {
  const p = {
    agentDirs: [],
    retentionDays: 14,
    keepGlobs: [],
    apply: false,
    includeMain: false,
    mainRetentionDays: 30,
    trashDir: path3.join(os.homedir(), ".pi-cleanup/trash"),
    trashRetentionDays: 7,
    json: false
  };
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined)
      throw new Error(`${flag} requires a value`);
    return v;
  };
  const posInt = (raw, flag) => {
    if (!/^\d+$/.test(raw.trim()))
      throw new Error(`${flag} must be a non-negative integer`);
    return Number(raw.trim());
  };
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "--agent-dir":
        p.agentDirs.push(path3.resolve(need(i, a)));
        i++;
        break;
      case "--retention-days":
        p.retentionDays = posInt(need(i, a), a);
        i++;
        break;
      case "--keep":
        p.keepGlobs.push(need(i, a));
        i++;
        break;
      case "--apply":
        p.apply = true;
        break;
      case "--include-main":
        p.includeMain = true;
        break;
      case "--main-retention-days":
        p.mainRetentionDays = posInt(need(i, a), a);
        i++;
        break;
      case "--trash-dir":
        p.trashDir = path3.resolve(need(i, a));
        i++;
        break;
      case "--trash-retention-days":
        p.trashRetentionDays = posInt(need(i, a), a);
        i++;
        break;
      case "--json":
        p.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (p.agentDirs.length === 0)
    p.agentDirs = defaultAgentDirs();
  return p;
}
function fmtBytes(n) {
  if (n < 1024)
    return `${n}B`;
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
function report(result) {
  const mode = result.dryRun ? "DRY-RUN (no changes)" : "APPLIED";
  process.stdout.write(`pi-session-cleanup ${mode}
`);
  for (const d of result.perDir) {
    process.stdout.write(`  ${d.agentDir}
` + `    ok=${d.ok} scanned=${d.scannedTranscripts} referenced=${d.referencedCount} ` + `orphan_index=${d.orphanIndexRemoved.length} quarantined=${d.quarantinedTranscripts.length} ` + `main_quarantined=${d.quarantinedMainSessions.length} kept_by_glob=${d.keptByGlob} ` + `reclaim=${fmtBytes(d.bytesReclaimed)}
`);
    for (const e of d.errors)
      process.stdout.write(`    ERROR: ${e}
`);
  }
  if (result.trashExpiredDirs.length > 0) {
    process.stdout.write(`  trash expired: ${result.trashExpiredDirs.join(", ")} (${fmtBytes(result.trashBytesFreed)})
`);
  }
  process.stdout.write(`PI_SESSION_CLEANUP status=${result.ok ? "ok" : "error"} dry_run=${result.dryRun} ` + `scanned=${result.totals.scannedTranscripts} orphan_index=${result.totals.orphanIndexRemoved} ` + `quarantined=${result.totals.quarantinedTranscripts} main_quarantined=${result.totals.quarantinedMainSessions} ` + `reclaimed=${result.totals.bytesReclaimed} trash_expired=${result.trashExpiredDirs.length} ` + `trash_freed=${result.trashBytesFreed} at=${new Date().toISOString()}
`);
}
function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`argument error: ${err.message}
`);
    usage();
    process.exit(2);
  }
  const opts = {
    agentDirs: parsed.agentDirs,
    retentionDays: parsed.retentionDays,
    keepGlobs: parsed.keepGlobs,
    apply: parsed.apply,
    includeMain: parsed.includeMain,
    mainRetentionDays: parsed.mainRetentionDays,
    trashDir: parsed.trashDir,
    trashRetentionDays: parsed.trashRetentionDays
  };
  const result = runCleanup(opts);
  if (parsed.json)
    process.stdout.write(JSON.stringify(result, null, 2) + `
`);
  else
    report(result);
  process.exit(result.ok ? 0 : 1);
}
main();
