/**
 * Muse の試遊結果の中継の組み立て (spec/feature/playtest-review-notify.md — Muse の結果の中継)。 bootstrap から 1 回だけ呼ぶ。
 * 指令ブリッジの subscribe で finished を受け、 起動時に台帳から再開し、 周期で再試行する。
 *
 * @implements spec/feature/playtest-review-notify.md — Muse の結果の中継
 */

import type Database from "better-sqlite3";
import type { InstructionEventListener } from "../agent-instructions/instruction-events.js";
import { SqliteMusePlaytestRelayStore } from "../db/muse-playtest-relays-repo.js";
import { MusePlaytestRelay, type MuseRelayDeps } from "./muse-relay.js";
import type { RelayView } from "./muse-relay-policy.js";
import { saveVoluptasReview } from "./voluptas-client.js";

export const MUSE_RELAY_TICK_MS = 60_000;

export interface MuseRelayRuntime {
  viewOf: (id: string) => RelayView | null;
  stop: () => void;
}

export function startMusePlaytestRelay(input: Omit<MuseRelayDeps, "store" | "save"> & {
  db: Database.Database;
  subscribe: (listener: InstructionEventListener) => () => void;
  save?: MuseRelayDeps["save"];
  tickMs?: number;
}): MuseRelayRuntime {
  const relay = new MusePlaytestRelay({
    ...input,
    store: new SqliteMusePlaytestRelayStore(input.db),
    save: input.save ?? ((connection, runId, body) => saveVoluptasReview(connection, runId, body)),
  });
  const unsubscribe = input.subscribe((event) => relay.handle(event));
  const warn = (error: unknown) => input.log.warn({ error: error instanceof Error ? error.message : String(error) }, "muse playtest relay tick failed");
  relay.resume().catch(warn);
  const timer = setInterval(() => { relay.tick().catch(warn); }, input.tickMs ?? MUSE_RELAY_TICK_MS);
  timer.unref?.();
  return {
    viewOf: (id) => relay.view(id),
    stop: () => { clearInterval(timer); unsubscribe(); },
  };
}
