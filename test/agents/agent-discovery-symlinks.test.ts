/**
 * Don fork: agent files deployed as symlinks, and session lifecycle metadata.
 *
 * Relocated from the live fork's src/agents/agent-discovery.test.ts, which
 * upstream's vitest config would never collect.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgentFilesInDir, parseAgentFile, mergeAgents } from "../../src/agents/agent-discovery.js";
import type { AgentConfig } from "../../src/agents/types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-discovery-"));
  dirs.push(root);
  return root;
}

describe("scanAgentFilesInDir — symlinked agent files", () => {
  it("discovers agent definitions deployed as relative symlinks", async () => {
    // A shared agent library is deployed with `ln -s ../lib/executor.md`.
    // readdir reports those entries as symlinks, not files.
    const root = await tempRoot();
    const agents = join(root, "agents");
    await mkdir(agents);
    await writeFile(
      join(root, "executor-source.md"),
      "---\nname: executor\nmodel: walmart-puppy/gpt-5.6-terra\n---\nReply exactly EXECUTOR_OK.\n",
    );
    await symlink("../executor-source.md", join(agents, "executor.md"));

    const discovered = await scanAgentFilesInDir(agents, "user");

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.name).toBe("executor");
    expect(discovered[0]?.model).toBe("walmart-puppy/gpt-5.6-terra");
  });

  it("continues to discover regular files", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "scout.md"), "---\nname: scout\n---\nRead only.\n");

    const discovered = await scanAgentFilesInDir(root, "user");

    expect(discovered.map((agent) => agent.name)).toEqual(["scout"]);
  });

  it("skips broken and directory symlinks without failing the scan", async () => {
    const root = await tempRoot();
    const agents = join(root, "agents");
    const directoryTarget = join(root, "not-an-agent");
    await mkdir(agents);
    await mkdir(directoryTarget);
    await writeFile(join(agents, "valid.md"), "---\nname: valid\n---\nValid.\n");
    await symlink("../missing.md", join(agents, "broken.md"));
    await symlink(directoryTarget, join(agents, "directory.md"));

    const discovered = await scanAgentFilesInDir(agents, "user");

    expect(discovered.map((agent) => agent.name)).toEqual(["valid"]);
  });

  it("ignores a symlink that does not end in .md", async () => {
    const root = await tempRoot();
    const agents = join(root, "agents");
    await mkdir(agents);
    await writeFile(join(root, "notes.txt"), "---\nname: notes\n---\nNot an agent.\n");
    await symlink("../notes.txt", join(agents, "notes.txt"));

    expect(await scanAgentFilesInDir(agents, "user")).toEqual([]);
  });
});

describe("session lifecycle metadata", () => {
  const parse = (frontmatter: string) => parseAgentFile(`---\n${frontmatter}\n---\nBody.\n`, "user");

  it("defaults to undefined when neither field is set", () => {
    const parsed = parse("name: scout");
    expect(parsed?.session_lifecycle).toBeUndefined();
    expect(parsed?.persistent_session).toBeUndefined();
  });

  it("parses session_lifecycle: persistent", () => {
    expect(parse("name: executor\nsession_lifecycle: persistent")?.session_lifecycle).toBe("persistent");
  });

  it("parses session_lifecycle: stateless", () => {
    expect(parse("name: scout\nsession_lifecycle: stateless")?.session_lifecycle).toBe("stateless");
  });

  it("drops an unrecognized lifecycle rather than failing the whole agent file", () => {
    // A future spelling must degrade to the stateless default, not make the
    // agent unloadable.
    const parsed = parse("name: scout\nsession_lifecycle: sometimes");
    expect(parsed?.name).toBe("scout");
    expect(parsed?.session_lifecycle).toBeUndefined();
  });

  it("parses the legacy persistent_session boolean", () => {
    expect(parse("name: executor\npersistent_session: true")?.persistent_session).toBe(true);
    expect(parse("name: scout\npersistent_session: false")?.persistent_session).toBe(false);
  });
});

describe("mergeAgents — lifecycle resolution", () => {
  const merge = (frontmatter: string) => {
    const parsed = parseAgentFile(`---\n${frontmatter}\n---\nBody.\n`, "user")!;
    return mergeAgents(new Map<string, AgentConfig>(), [parsed], [], []).get(parsed.name!)!;
  };

  it("maps session_lifecycle: persistent onto both fields", () => {
    const config = merge("name: executor\nsession_lifecycle: persistent");
    expect(config.sessionLifecycle).toBe("persistent");
    expect(config.persistentSession).toBe(true);
  });

  it("maps the legacy boolean onto sessionLifecycle", () => {
    expect(merge("name: executor\npersistent_session: true").sessionLifecycle).toBe("persistent");
    expect(merge("name: scout\npersistent_session: false").sessionLifecycle).toBe("stateless");
  });

  it("lets session_lifecycle win when both agree", () => {
    const config = merge("name: executor\nsession_lifecycle: persistent\npersistent_session: true");
    expect(config.sessionLifecycle).toBe("persistent");
    expect(config.persistentSession).toBe(true);
  });

  it("throws when the two spellings contradict each other", () => {
    // Silently picking one would give a keyed agent the opposite lifecycle
    // from what its author wrote.
    expect(() => merge("name: executor\nsession_lifecycle: persistent\npersistent_session: false")).toThrow(
      /conflicting session_lifecycle and persistent_session/,
    );
  });

  it("leaves both fields unset when the frontmatter says nothing", () => {
    const config = merge("name: scout");
    expect(config.sessionLifecycle).toBeUndefined();
    expect(config.persistentSession).toBeUndefined();
  });
});
