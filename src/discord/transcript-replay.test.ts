import { describe, it, expect } from "vitest";
import { replayPersistedTranscript } from "./transcript-replay.js";
import type { ConcordiaEvent } from "../events.js";
import type { TranscriptLogEntry } from "../db/transcript-logs-repo.js";

function entry(id: number, seq: number, kind: string): TranscriptLogEntry {
  return { id, seq, ts: 1000 + seq, kind, payload: { text: `f${seq}` } };
}

function makeDeps(entries: TranscriptLogEntry[]) {
  const emitted: ConcordiaEvent[] = [];
  const logs: string[] = [];
  return {
    emitted,
    logs,
    deps: {
      transcriptLogs: { listBySession: () => entries },
      log: { info: (m: string) => logs.push(m) },
      emit: (ev: ConcordiaEvent) => { emitted.push(ev); },
    },
  };
}

describe("replayPersistedTranscript", () => {
  it("text / summary の frame だけを id<=upToId の範囲で時系列順に再放流する", () => {
    const { deps, emitted } = makeDeps([
      entry(1, 0, "raw"),
      entry(2, 1, "text"),
      entry(3, 2, "tool-use"),
      entry(4, 3, "summary"),
      entry(5, 4, "text"), // upToId より後 = ライブ配信済み → 対象外
    ]);
    const replayed = replayPersistedTranscript(deps, "s1", 4);
    expect(replayed).toBe(2);
    expect(emitted.map((e) => (e.type === "transcript.frame" ? e.seq : -1))).toEqual([1, 3]);
    const first = emitted[0];
    expect(first.type).toBe("transcript.frame");
    if (first.type === "transcript.frame") {
      expect(first.target_session_id).toBe("s1");
      expect(first.kind).toBe("text");
      expect(first.payload).toEqual({ text: "f1" });
    }
  });

  it("upToId=0 (frame なし) は何もせず 0 を返す", () => {
    const { deps, emitted } = makeDeps([entry(1, 0, "text")]);
    expect(replayPersistedTranscript(deps, "s1", 0)).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it("対象 0 件なら info ログも出さない", () => {
    const { deps, logs } = makeDeps([entry(1, 0, "raw")]);
    expect(replayPersistedTranscript(deps, "s1", 1)).toBe(0);
    expect(logs).toHaveLength(0);
  });
});
