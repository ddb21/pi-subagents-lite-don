import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgentFilesInDir } from "./agent-discovery.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("scanAgentFilesInDir", () => {
  it("discovers agent definitions deployed as relative symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-discovery-"));
    dirs.push(root);
    const source = join(root, "executor-source.md");
    const agents = join(root, "agents");
    await mkdir(agents);
    await writeFile(source, "---\nname: executor\nmodel: walmart-puppy/gpt-5.6-terra\n---\nReply exactly EXECUTOR_OK.\n");
    await symlink("../executor-source.md", join(agents, "executor.md"));

    const discovered = await scanAgentFilesInDir(agents, "user");

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.name).toBe("executor");
    expect(discovered[0]?.model).toBe("walmart-puppy/gpt-5.6-terra");
  });

  it("continues to discover regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-discovery-"));
    dirs.push(root);
    await writeFile(join(root, "scout.md"), "---\nname: scout\n---\nRead only.\n");

    const discovered = await scanAgentFilesInDir(root, "user");

    expect(discovered.map((agent) => agent.name)).toEqual(["scout"]);
  });

  it("skips broken and directory symlinks without failing the scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-discovery-"));
    dirs.push(root);
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
});
