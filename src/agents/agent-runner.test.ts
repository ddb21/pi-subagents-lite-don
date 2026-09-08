import { describe, expect, it } from "vitest";
import { extractExtensionName, findMissingDeclaredExtensions } from "./agent-runner.js";

describe("spawn-time extension declaration validation", () => {
  it("extracts the installed package name from npm and local extension paths", () => {
    expect(extractExtensionName("/opt/node_modules/pi-bg-run-don/dist/index.js")).toBe("pi-bg-run-don");
    expect(extractExtensionName("/home/me/.pi/agent/extensions/pi-lens/index.ts")).toBe("pi-lens");
  });

  it("uses exact package-name matching and reports missing declarations", () => {
    const loaded = [
      { path: "/opt/node_modules/pi-bg-run-don/dist/index.js" },
      { path: "/home/me/.pi/agent/extensions/other.ts" },
    ];

    expect(findMissingDeclaredExtensions(["pi-lens", "pi-bg-run"], loaded))
      .toEqual(["pi-lens", "pi-bg-run"]);
    expect(findMissingDeclaredExtensions(["pi-bg-run-don"], loaded)).toEqual([]);
  });
});
