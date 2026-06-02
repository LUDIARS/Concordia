import { describe, it, expect } from "vitest";
import { WorkingIndicator } from "./working-indicator.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHarness(opts: { repostDelayMs: number; idleMs: number }) {
  const posts: string[] = [];
  const removes: string[] = [];
  let seq = 0;
  const ind = new WorkingIndicator({
    repostDelayMs: opts.repostDelayMs,
    idleMs: opts.idleMs,
    post: async (sessionId) => {
      const id = `m${++seq}`;
      posts.push(`${sessionId}:${id}`);
      return id;
    },
    remove: async (sessionId, messageId) => {
      removes.push(`${sessionId}:${messageId}`);
    },
  });
  return { ind, posts, removes };
}

describe("WorkingIndicator", () => {
  it("進捗後 settle で最下部に1回投稿する", async () => {
    const { ind, posts } = makeHarness({ repostDelayMs: 20, idleMs: 10_000 });
    ind.noteProgress("s1");
    expect(posts).toEqual([]); // settle 前は未投稿
    await sleep(40);
    expect(posts).toEqual(["s1:m1"]);
    expect(ind.hasIndicator("s1")).toBe(true);
  });

  it("settle 前に進捗が連続すると投稿は1回だけ（フリッカ抑制）", async () => {
    const { ind, posts } = makeHarness({ repostDelayMs: 30, idleMs: 10_000 });
    ind.noteProgress("s1");
    await sleep(10);
    ind.noteProgress("s1"); // reset
    await sleep(10);
    ind.noteProgress("s1"); // reset
    await sleep(50);
    expect(posts.length).toBe(1);
  });

  it("既出インジケータがある状態で進捗が来ると削除→再投稿", async () => {
    const { ind, posts, removes } = makeHarness({ repostDelayMs: 15, idleMs: 10_000 });
    ind.noteProgress("s1");
    await sleep(30); // m1 投稿
    expect(posts).toEqual(["s1:m1"]);
    ind.noteProgress("s1"); // m1 を即削除 → settle 後 m2
    await sleep(40);
    expect(removes).toEqual(["s1:m1"]);
    expect(posts).toEqual(["s1:m1", "s1:m2"]);
  });

  it("idle 経過でインジケータを除去する", async () => {
    const { ind, posts, removes } = makeHarness({ repostDelayMs: 15, idleMs: 60 });
    ind.noteProgress("s1");
    await sleep(30); // m1 投稿
    expect(ind.hasIndicator("s1")).toBe(true);
    await sleep(80); // idle 経過
    expect(removes).toContain("s1:m1");
    expect(ind.hasIndicator("s1")).toBe(false);
  });

  it("clear で即除去する", async () => {
    const { ind, removes } = makeHarness({ repostDelayMs: 15, idleMs: 10_000 });
    ind.noteProgress("s1");
    await sleep(30);
    ind.clear("s1");
    await sleep(20);
    expect(removes).toEqual(["s1:m1"]);
    expect(ind.hasIndicator("s1")).toBe(false);
  });

  it("セッションごとに独立", async () => {
    const { ind, posts } = makeHarness({ repostDelayMs: 15, idleMs: 10_000 });
    ind.noteProgress("s1");
    ind.noteProgress("s2");
    await sleep(35);
    expect(posts.sort()).toEqual(["s1:m1", "s2:m2"].sort());
  });
});
