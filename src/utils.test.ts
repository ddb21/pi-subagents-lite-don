import { describe, expect, it } from "vitest";
import { parseModelKey, parseThinkingLevel, splitModelThinkingSuffix } from "./utils.js";

describe("model thinking suffix helpers", () => {
  it("splits only recognized pi thinking suffixes", () => {
    expect(splitModelThinkingSuffix("walmart-puppy/gpt-5.6-sol:xhigh"))
      .toEqual({ model: "walmart-puppy/gpt-5.6-sol", thinking: "xhigh" });
    expect(splitModelThinkingSuffix("walmart-puppy/gpt-5.6-sol:max"))
      .toEqual({ model: "walmart-puppy/gpt-5.6-sol", thinking: "max" });
    expect(splitModelThinkingSuffix("ollama/llama3.1:8b"))
      .toEqual({ model: "ollama/llama3.1:8b" });
  });

  it("parses model keys after removing recognized thinking suffixes", () => {
    expect(parseModelKey("walmart-puppy/gpt-5.6-sol:xhigh"))
      .toEqual({ provider: "walmart-puppy", modelId: "gpt-5.6-sol" });
    expect(parseModelKey("ollama/llama3.1:8b"))
      .toEqual({ provider: "ollama", modelId: "llama3.1:8b" });
  });

  it("accepts max as a first-class thinking level", () => {
    expect(parseThinkingLevel("max")).toBe("max");
  });
});
