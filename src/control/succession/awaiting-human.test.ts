import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types.js";
import { isAwaitingHumanInput } from "../stalled-session-nudge.js";
import { isSessionAwaitingHuman, type AwaitingHumanPorts } from "./awaiting-human.js";

const SESSION = { id: "s1", transcript_path: "x.jsonl" } as SessionRow;

const ASK_TAIL = [
  JSON.stringify({ type: "user", message: { role: "user", content: "進めて" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "どうしますか?\n```ask\n{\"question\":\"q\",\"options\":[]}\n```" }] } }),
].join("\n");

const ANSWERED_TAIL = `${ASK_TAIL}\n${JSON.stringify({ type: "user", message: { role: "user", content: "直す" } })}`;

function ports(overrides: Partial<AwaitingHumanPorts> & { tail?: string | null } = {}): AwaitingHumanPorts & { reads: number } {
  const state = { reads: 0 };
  return Object.assign(state, {
    hasUnansweredQuestion: () => false,
    isHumanWaitActive: () => false,
    isWaitingForHumanResponse: () => false,
    readTranscriptTail: async () => { state.reads++; return overrides.tail ?? null; },
    isAskMarkerPending: isAwaitingHumanInput,
    ...overrides,
  });
}

describe("isSessionAwaitingHuman (session-auto-succession.md §2.1 awaiting_human)", () => {
  it("待ちの signal が無ければ偽", async () => {
    expect(await isSessionAwaitingHuman(ports({ tail: ANSWERED_TAIL }), SESSION)).toBe(false);
    expect(await isSessionAwaitingHuman(ports({ tail: null }), SESSION)).toBe(false);
  });

  it("transcript 末尾の ask マーカー (カードを出さない Lictor relay の質問) を待ちとみなす", async () => {
    expect(await isSessionAwaitingHuman(ports({ tail: ASK_TAIL }), SESSION)).toBe(true);
  });

  it.each([
    ["質問カード", { hasUnansweredQuestion: () => true }],
    ["human-wait", { isHumanWaitActive: () => true }],
    ["確認待ち", { isWaitingForHumanResponse: () => true }],
  ] as const)("%s が立っていれば transcript を読まずに待ちとみなす", async (_label, override) => {
    const p = ports({ ...override, tail: ANSWERED_TAIL });
    expect(await isSessionAwaitingHuman(p, SESSION)).toBe(true);
    expect(p.reads).toBe(0);
  });
});
