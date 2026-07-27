#!/usr/bin/env bun
// Automatic cleanup for accumulated keyed subagent session state.
// Quarantine-based and reversible: dry-run by default, `--apply` to act.
//
//   bun run bin/pi-session-cleanup.ts                 # dry-run, default dirs
//   bun run bin/pi-session-cleanup.ts --apply         # act
//   bun run bin/pi-session-cleanup.ts --agent-dir DIR --retention-days 14
//   bun run bin/pi-session-cleanup.ts --include-main --main-retention-days 30
//
// Exit code is non-zero if any agent dir failed (e.g. a corrupt index), so
// launchd/Fleet Monitor sees a real health signal rather than log freshness.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCleanup, type CleanupOptions, type CleanupResult } from "../src/agents/session-cleanup.js";

interface Parsed {
  agentDirs: string[];
  retentionDays: number;
  keepGlobs: string[];
  apply: boolean;
  includeMain: boolean;
  mainRetentionDays: number;
  trashDir: string;
  trashRetentionDays: number;
  json: boolean;
}

function usage(): void {
  process.stdout.write(
    [
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
      "",
    ].join("\n"),
  );
}

function defaultAgentDirs(): string[] {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.trim()) return [env.trim()];
  return [path.join(os.homedir(), ".pi/agent"), path.join(os.homedir(), ".pi-lite/agent")].filter((d) =>
    fs.existsSync(d),
  );
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    agentDirs: [],
    retentionDays: 14,
    keepGlobs: [],
    apply: false,
    includeMain: false,
    mainRetentionDays: 30,
    trashDir: path.join(os.homedir(), ".pi-cleanup/trash"),
    trashRetentionDays: 7,
    json: false,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  const posInt = (raw: string, flag: string): number => {
    if (!/^\d+$/.test(raw.trim())) throw new Error(`${flag} must be a non-negative integer`);
    return Number(raw.trim());
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "--agent-dir":
        p.agentDirs.push(path.resolve(need(i, a)));
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
        p.trashDir = path.resolve(need(i, a));
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
  if (p.agentDirs.length === 0) p.agentDirs = defaultAgentDirs();
  return p;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function report(result: CleanupResult): void {
  const mode = result.dryRun ? "DRY-RUN (no changes)" : "APPLIED";
  process.stdout.write(`pi-session-cleanup ${mode}\n`);
  for (const d of result.perDir) {
    process.stdout.write(
      `  ${d.agentDir}\n` +
        `    ok=${d.ok} scanned=${d.scannedTranscripts} referenced=${d.referencedCount} ` +
        `orphan_index=${d.orphanIndexRemoved.length} quarantined=${d.quarantinedTranscripts.length} ` +
        `main_quarantined=${d.quarantinedMainSessions.length} kept_by_glob=${d.keptByGlob} ` +
        `reclaim=${fmtBytes(d.bytesReclaimed)}\n`,
    );
    for (const e of d.errors) process.stdout.write(`    ERROR: ${e}\n`);
  }
  if (result.trashExpiredDirs.length > 0) {
    process.stdout.write(
      `  trash expired: ${result.trashExpiredDirs.join(", ")} (${fmtBytes(result.trashBytesFreed)})\n`,
    );
  }
  // Single-line marker (last-fire signal for the Fleet Monitor log).
  process.stdout.write(
    `PI_SESSION_CLEANUP status=${result.ok ? "ok" : "error"} dry_run=${result.dryRun} ` +
      `scanned=${result.totals.scannedTranscripts} orphan_index=${result.totals.orphanIndexRemoved} ` +
      `quarantined=${result.totals.quarantinedTranscripts} main_quarantined=${result.totals.quarantinedMainSessions} ` +
      `reclaimed=${result.totals.bytesReclaimed} trash_expired=${result.trashExpiredDirs.length} ` +
      `trash_freed=${result.trashBytesFreed} at=${new Date().toISOString()}\n`,
  );
}

function main(): void {
  let parsed: Parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    process.stderr.write(`argument error: ${(err as Error).message}\n`);
    usage();
    process.exit(2);
  }
  const opts: CleanupOptions = {
    agentDirs: parsed.agentDirs,
    retentionDays: parsed.retentionDays,
    keepGlobs: parsed.keepGlobs,
    apply: parsed.apply,
    includeMain: parsed.includeMain,
    mainRetentionDays: parsed.mainRetentionDays,
    trashDir: parsed.trashDir,
    trashRetentionDays: parsed.trashRetentionDays,
  };
  const result = runCleanup(opts);
  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else report(result);
  process.exit(result.ok ? 0 : 1);
}

main();
