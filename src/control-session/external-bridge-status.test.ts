import { expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { controlSessionRouter } from "../api/control-session.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { ConfluxRepository } from "../conflux/repository.js";
import { PlaytestDeliveryEvidence } from "../playtest-review/delivery-evidence.js";
import { readExternalBridges, renderExternalBridgeLines } from "./external-bridge-status.js";
import { renderHourlySummary } from "./hourly-summary.js";

it("reports all bridge states, queue counts and failure evidence in JSON and Markdown", async () => {
  const db = makeTestDb();
  const store = new SqliteAgentInstructionStore(db);
  let elapsed = 0;
  let configured = false;
  const now = () => new Date(Date.UTC(2026, 10, 21) + 1000 * elapsed);
  const muse = new InstructionService({ store, now });
  const review = new PlaytestDeliveryEvidence(db, now);
  const conflux = new ConfluxRepository(db);
  const externalBridges = () => readExternalBridges({
    muse: () => ({ configured, ...store.evidence("muse") }),
    conflux: () => ({ configured, ...conflux.hookEvidence() }),
    playtest_review: () => ({ configured, ...review.read() }),
  }, () => {});
  const router = controlSessionRouter({
    isEnabled: () => true, holder: () => null, currentControlSessionId: () => null, boardRows: () => [],
    dispatch: async () => { throw new Error("no dispatch in this scenario"); },
    externalBridges,
  });
  const statuses = () => externalBridges().map(({ status }) => status);
  expect(statuses()).toEqual(["unconfigured", "unconfigured", "unconfigured"]);
  configured = true;
  expect(statuses()).toEqual(["unused", "unused", "unused"]);
  const instruction = () => muse.register({ agent: "muse", type: "playtest", title: "Test", body: "Play", params: {} });
  const success = instruction();
  muse.recordResult(success.id, { agent: "muse", status: "done", summary: "done" });
  const pending = instruction();
  muse.ack(pending.id, "muse");
  instruction();
  conflux.enqueue({ key: "build", path: "/api/hooks/build-events", payload: {} });
  conflux.finishHook("build", +now());
  const target = { kind: "cc-channel" as const, target: "hq" };
  const outcome = { duplicate: false, unconfigured: false, delivered: [{ target }], failed: [], tabula: null, video: null };
  review.record(outcome);
  expect(statuses()).toEqual(["healthy", "healthy", "healthy"]);
  elapsed++;
  muse.recordResult(instruction().id, { agent: "muse", status: "failed", summary: "trial failed" });
  conflux.enqueue({ key: "merge", path: "/api/hooks/integration", payload: {} });
  conflux.finishHook("merge", +now(), 1000, "HTTP 503");
  review.record({ ...outcome, delivered: [], failed: [{ target, error: "private response" }] });
  const json = await (await router.request("/board")).json();
  expect(json.external_bridges).toEqual([
    expect.objectContaining({ id: "muse", status: "failed", last_failure_reason: "trial failed", pending: 1, running: 1 }),
    expect.objectContaining({ id: "conflux", status: "failed", last_failure_reason: "HTTP 503" }),
    expect.objectContaining({ id: "playtest_review", status: "failed", last_failure_reason: "チャット配送失敗" }),
  ]);
  const summary = renderHourlySummary([], +now(), [], undefined, renderExternalBridgeLines(externalBridges()));
  expect(summary).toContain("Muse 指令ブリッジ / 失敗あり");
  expect(summary).toContain("Conflux 外部通知フック / 失敗あり");
  expect(summary).toContain("Playtest Review 受け口 / 失敗あり");
  expect(summary).toContain("保留 1 / 実行中 1");
  expect(summary).not.toContain("private response");
});
