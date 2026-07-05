import { describe, expect, it } from "vitest";
import { chatEmbeddedEnabled, readChatMode } from "./chat.js";
import { costEmbeddedEnabled, readCostMode } from "./cost.js";

describe("bootstrap modes", () => {
  it("defaults chat and cost to embedded", () => {
    expect(readChatMode({} as NodeJS.ProcessEnv)).toBe("embedded");
    expect(readCostMode({} as NodeJS.ProcessEnv)).toBe("embedded");
  });

  it("recognizes off and worker modes", () => {
    expect(readChatMode({ CONCORDIA_CHAT_MODE: "off" } as NodeJS.ProcessEnv)).toBe("off");
    expect(readChatMode({ CONCORDIA_CHAT_MODE: "worker" } as NodeJS.ProcessEnv)).toBe("worker");
    expect(readCostMode({ CONCORDIA_COST_MODE: "off" } as NodeJS.ProcessEnv)).toBe("off");
    expect(readCostMode({ CONCORDIA_COST_MODE: "worker" } as NodeJS.ProcessEnv)).toBe("worker");
  });

  it("enables embedded runtimes only in embedded mode", () => {
    expect(chatEmbeddedEnabled({ CONCORDIA_CHAT_MODE: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(costEmbeddedEnabled({ CONCORDIA_COST_MODE: "worker" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
