/** Append-only benchmark lifecycle events. Enabled only by PI_BENCH_LIFECYCLE_FILE. */
import fs from "node:fs";
import path from "node:path";

export interface LifecycleEvent { event: string; timestamp_ct: string; [key: string]: unknown }

function nowCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace(", ", "T") + "-05:00";
}

export function emitLifecycle(event: string, fields: Record<string, unknown> = {}): void {
  const file = process.env.PI_BENCH_LIFECYCLE_FILE;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ event, timestamp_ct: nowCT(), ...benchmarkContext(), ...fields }) + "\n", "utf8");
  } catch { /* Benchmark telemetry must never alter agent execution. */ }
}

export function benchmarkContext(): Record<string, string> {
  const env = process.env;
  return {
    trial_id: env.PI_BENCH_TRIAL_ID ?? "",
    arm: env.PI_BENCH_ARM ?? "",
    task: env.PI_BENCH_TASK ?? "",
    pair: env.PI_BENCH_PAIR ?? "",
    order: env.PI_BENCH_ORDER ?? "",
  };
}

export function lifecycleEnabled(): boolean { return Boolean(process.env.PI_BENCH_LIFECYCLE_FILE); }
