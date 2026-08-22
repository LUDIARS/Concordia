import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";
import { startCheckoutPublishedDeployWatch } from "./watch.js";

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-watch-"));
  mkdirSync(join(root, "Concordia", ".git"), { recursive: true });
  return root;
}

function makeWatch(overrides: Record<string, unknown> = {}) {
  const controls: string[] = [];
  const chatted: string[] = [];
  const root = workspaceRoot();
  const handle = startCheckoutPublishedDeployWatch({
    resolveServiceCode: async () => "concordia",
    resolveWorkspaceRoots: () => [root],
    excubitor: {
      control: async (code: string, action: "restart") => {
        controls.push(`${code}:${action}`);
        return { ok: true, action, exit_code: 0 };
      },
    },
    claims: new TestingClaimsRepo(makeTestDb()),
    build: async () => ({ ok: true, ran: false }),
    chat: {
      insert: ((input: { channel: string; author_label: string; text: string; session_id: string | null }) => {
        chatted.push(input.text);
        return { id: chatted.length, ts: 1, in_reply_to: null, is_actionable: 0, metadata: null, ...input } as never;
      }) as never,
    },
    ...overrides,
  });
  return { handle, controls, chatted };
}

/** chat.posted の購読 (投稿が live な購読者へ届くことの確認用)。 */
function captureChatPosted(): { posted: Array<{ channel: string }>; stop: () => void } {
  const posted: Array<{ channel: string }> = [];
  const stop = eventBus.subscribe((event) => {
    if (event.type === "chat.posted") posted.push({ channel: event.channel });
  });
  return { posted, stop };
}

function inject(text: string): void {
  eventBus.emit({ type: "session.inject", target_session_id: "s1", text, source: "revisor", ts: 1 });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 直列化された deploy が全部片付くまで待つ (固定 tick 数に依存しないため)。 */
async function flushUntil(done: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !done(); i += 1) await flush();
}

describe("checkout_published の購読", () => {
  it("Revisor inject の checkout 前進で deploy し、1 行残す", async () => {
    const { handle, controls, chatted } = makeWatch();
    const chat = captureChatPosted();
    try {
      inject("checkout_published: LUDIARS/Concordia#364 本体 checkout を 1a2b3c4 へ前進させました");
      await flushUntil(() => chatted.length >= 1);
    } finally {
      handle.stop();
      chat.stop();
    }
    expect(controls).toEqual(["concordia:restart"]);
    expect(chatted).toHaveLength(1);
    expect(chatted[0]).toContain("再起動しました");
    // insert だけでは Web UI / ミラーへ届かない。 chat.posted まで出て初めて視認できる。
    expect(chat.posted).toEqual([{ channel: "system" }]);
  });

  it("同じ前進が二重に届いても再起動は 1 回だけ", async () => {
    const { handle, controls } = makeWatch();
    try {
      inject("checkout_published: Concordia#364 本体 checkout を 1a2b3c4 へ前進させました");
      inject("checkout_published: Concordia#364 本体 checkout を 1a2b3c4 へ前進させました");
      await flush();
    } finally {
      handle.stop();
    }
    expect(controls).toEqual(["concordia:restart"]);
  });

  it("sha が読めない別々の前進を 1 本に畳まない", async () => {
    // repo だけを抑止キーにすると、別の PR の前進が 10 分窓で黙って落ちる
    // (= main は進んだのにサービスは古いまま — この機構が防ぐはずの状態)。
    const { handle, controls } = makeWatch();
    try {
      inject("checkout_published: Concordia#364 を反映しました");
      inject("checkout_published: Concordia#365 を反映しました");
      await flushUntil(() => controls.length >= 2);
    } finally {
      handle.stop();
    }
    expect(controls).toEqual(["concordia:restart", "concordia:restart"]);
  });

  it("Revisor 以外の inject や checkout 前進以外の通知では動かない", async () => {
    const { handle, controls } = makeWatch();
    try {
      eventBus.emit({
        type: "session.inject",
        target_session_id: "s1",
        text: "checkout_published: Concordia#1",
        source: "discord",
        ts: 1,
      });
      inject("🟣 Revisor PR マージ: Concordia#364");
      await flush();
    } finally {
      handle.stop();
    }
    expect(controls).toEqual([]);
  });

  it("stop 後は購読しない", async () => {
    const { handle, controls } = makeWatch();
    handle.stop();
    inject("checkout_published: Concordia#999 本体 checkout を abcdef1 へ前進させました");
    await flush();
    expect(controls).toEqual([]);
  });
});
