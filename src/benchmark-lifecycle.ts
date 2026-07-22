/** Append-only benchmark lifecycle events. Enabled only by PI_BENCH_LIFECYCLE_FILE. */
import fs from "node:fs";
import path from "node:path";

export interface LifecycleEvent { event: string; timestamp_ct: string; [key: string]: unknown }

function nowCT(): string {
  // formatToParts preserves the real CT offset across CST/CDT transitions.
  const date = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const utcMillis = Date.UTC(+value("year"), +value("month") - 1, +value("day"), +value("hour"), +value("minute"), +value("second"));
  const offsetMinutes = Math.round((utcMillis - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function emitLifecycle(event: string, fields: Record<string, unknown> = {}): void {
  const file = process.env.PI_BENCH_LIFECYCLE_FILE;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A single append syscall keeps each JSONL record intact for concurrent children.
    fs.appendFileSync(file, JSON.stringify({ event, timestamp_ct: nowCT(), timestamp_utc: new Date().toISOString(), ...benchmarkContext(), ...fields }) + "\n", "utf8");
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
