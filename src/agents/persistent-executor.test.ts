import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSubagentSessionDir, getSessionKeyIndexKey, recordSessionKey, resolveSessionKey } from "./persistent-executor.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-key-scope-"));
  dirs.push(agentDir);
  const cwd = join(agentDir, "project");
  const indexFile = join(getSubagentSessionDir(agentDir), "session-keys.json");
  return { agentDir, cwd, indexFile };
}


describe("keyed session scoping", () => {
  it("keeps same-CWD and same-key sessions isolated by canonical agent type", async () => {
    const { agentDir, cwd } = await fixture();
    const executorFile = join(agentDir, "executor.jsonl"); const deckFile = join(agentDir, "deck.jsonl");
    await writeFile(executorFile, "{}\n"); await writeFile(deckFile, "{}\n");
    recordSessionKey(agentDir, cwd, "executor", "shared", executorFile);
    recordSessionKey(agentDir, cwd, "data-deck", "shared", deckFile);
    expect(getSessionKeyIndexKey(cwd, "executor", "shared")).not.toBe(getSessionKeyIndexKey(cwd, "data-deck", "shared"));
    expect(resolveSessionKey(agentDir, cwd, "executor", "shared")).toBe(executorFile);
    expect(resolveSessionKey(agentDir, cwd, "data-deck", "shared")).toBe(deckFile);
  });

  it("uses valid scoped state before legacy state", async () => {
    const { agentDir, cwd, indexFile } =await fixture();
    const scoped = join(agentDir, "scoped.jsonl"); const legacy = join(agentDir, "legacy.jsonl");
    await writeFile(scoped, "{}\n"); await writeFile(legacy, "{}\n");
    await mkdir(getSubagentSessionDir(agentDir), { recursive: true });
    await writeFile(indexFile, JSON.stringify({ [getSessionKeyIndexKey(cwd, "executor", "same")]: scoped, [`${cwd}|same`]: legacy }) + "\n");
    expect(resolveSessionKey(agentDir, cwd, "executor", "same")).toBe(scoped);
  });

  it("migrates executor legacy state when scoped state is stale and deletes legacy", async () => {
    const { agentDir, cwd, indexFile } = await fixture();
    const legacy = join(agentDir, "legacy.jsonl"); await writeFile(legacy, "{}\n"); await mkdir(getSubagentSessionDir(agentDir), { recursive: true });
    await writeFile(indexFile, JSON.stringify({ [getSessionKeyIndexKey(cwd, "executor", "same")]: join(agentDir, "missing.jsonl"), [`${cwd}|same`]: legacy }) + "\n");
    expect(resolveSessionKey(agentDir, cwd, "executor", "same")).toBe(legacy);
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    expect(index[getSessionKeyIndexKey(cwd, "executor", "same")]).toBe(legacy);
    expect(index[`${cwd}|same`]).toBeUndefined();
  });

  it("refuses ambiguous legacy state for non-executor and ignores missing JSONL", async () => {
    const { agentDir, cwd, indexFile } = await fixture();
    await mkdir(getSubagentSessionDir(agentDir), { recursive: true });
    await writeFile(indexFile, JSON.stringify({ [`${cwd}|legacy`]: join(agentDir, "missing.jsonl") }) + "\n");
    expect(resolveSessionKey(agentDir, cwd, "data-deck", "legacy")).toBeUndefined();
    expect(resolveSessionKey(agentDir, cwd, "executor", "legacy")).toBeUndefined();
  });

  it("merges concurrent executor legacy migrations without losing entries", async () => {
    const { agentDir, cwd, indexFile } = await fixture();
    const one = join(agentDir, "one.jsonl"); const two = join(agentDir, "two.jsonl");
    await writeFile(one, "{}\n"); await writeFile(two, "{}\n"); await mkdir(getSubagentSessionDir(agentDir), { recursive: true });
    await writeFile(indexFile, JSON.stringify({ [`${cwd}|one`]: one, [`${cwd}|two`]: two }) + "\n");
    await Promise.all([Promise.resolve().then(() => resolveSessionKey(agentDir, cwd, "executor", "one")), Promise.resolve().then(() => resolveSessionKey(agentDir, cwd, "executor", "two"))]);
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    expect(index[getSessionKeyIndexKey(cwd, "executor", "one")]).toBe(one);
    expect(index[getSessionKeyIndexKey(cwd, "executor", "two")]).toBe(two);
    expect(index[`${cwd}|one`]).toBeUndefined(); expect(index[`${cwd}|two`]).toBeUndefined();
  });
});
