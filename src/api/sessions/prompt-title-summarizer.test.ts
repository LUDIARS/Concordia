import { describe, expect, it, vi } from "vitest";
import {
  applyPromptTitle,
  buildPromptTitleRequest,
  createHaikuPromptTitleSummarizer,
  type PromptTitleStore,
} from "./prompt-title-summarizer.js";

function memoryStore(initial: string | null = "前のタイトル"): PromptTitleStore & { current: () => string | null } {
  let currentTask = initial;
  return {
    findSession: () => ({ current_task: currentTask }),
    patchSession: (_id, patch) => { currentTask = patch.current_task; },
    current: () => currentTask,
  };
}

describe("applyPromptTitle (SPEC-SESSION-PROMPT-TITLE)", () => {
  it("leaves current_task untouched for control injects and never calls the summarizer", async () => {
    const store = memoryStore();
    const summarize = vi.fn(async () => "要約");
    const result = applyPromptTitle({ sessionId: "s", text: "[Cc policy update]\nbranch: main", store, summarize });
    await result.summarized;
    expect(store.current()).toBe("前のタイトル");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("writes the deterministic title first, then replaces it with the summary", async () => {
    const store = memoryStore();
    const onSummarized = vi.fn();
    const result = applyPromptTitle({
      sessionId: "s",
      text: "「neco」さんからの指示: MELPOTでMpとFg動かす",
      store,
      summarize: async (body) => (body === "MELPOTでMpとFg動かす" ? "MELPOT で Mp と Fg を起動する" : null),
      onSummarized,
    });
    expect(store.current()).toBe("MELPOTでMpとFg動かす");
    await result.summarized;
    expect(store.current()).toBe("MELPOT で Mp と Fg を起動する");
    expect(onSummarized).toHaveBeenCalledWith("s", "MELPOT で Mp と Fg を起動する");
  });

  it("keeps a newer title when the summary arrives after the next request", async () => {
    const store = memoryStore();
    let release: (title: string) => void = () => {};
    const result = applyPromptTitle({
      sessionId: "s",
      text: "最初の指示",
      store,
      summarize: () => new Promise((resolve) => { release = resolve; }),
    });
    store.patchSession("s", { current_task: "次の指示" });
    release("最初の指示の要約");
    await result.summarized;
    expect(store.current()).toBe("次の指示");
  });

  it("keeps the deterministic title when the summarizer fails", async () => {
    const store = memoryStore();
    const result = applyPromptTitle({ sessionId: "s", text: "Pagus を動かす", store, summarize: async () => { throw new Error("cli down"); } });
    await result.summarized;
    expect(store.current()).toBe("Pagus を動かす");
  });
});

describe("createHaikuPromptTitleSummarizer", () => {
  it("asks Haiku with the request wrapped as data and normalizes the answer", async () => {
    const runClaude = vi.fn(async () => ({ ok: true, stdout: "「Pagus を MELPOT で起動」\n", stderr: "" }));
    const summarize = createHaikuPromptTitleSummarizer(runClaude);
    await expect(summarize("Pagus を MELPOT で動かそう")).resolves.toBe("Pagus を MELPOT で起動");
    expect(runClaude).toHaveBeenCalledWith(buildPromptTitleRequest("Pagus を MELPOT で動かそう"), expect.objectContaining({ model: "haiku" }));
    expect(buildPromptTitleRequest("x")).toContain("<request>\nx\n</request>");
  });

  it("returns null on CLI failure and skips requests beyond the in-flight cap", async () => {
    let release: () => void = () => {};
    const runClaude = vi.fn(() => new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
      release = () => resolve({ ok: false, stdout: "", stderr: "timeout" });
    }));
    const summarize = createHaikuPromptTitleSummarizer(runClaude, { maxInFlight: 1 });
    const first = summarize("一つ目");
    await expect(summarize("二つ目")).resolves.toBeNull();
    release();
    await expect(first).resolves.toBeNull();
    expect(runClaude).toHaveBeenCalledTimes(1);
  });
});
