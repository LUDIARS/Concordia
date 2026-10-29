import { expect, it } from "vitest";
import { buildStatusReportGuidance } from "./status-report-policy.js";
import { buildStatusPreflightGuidance } from "./status-preflight-guidance.js";
import { buildParttimerInject } from "./parttimer-inject.js";

it("provides the same Cc checkout command for delegated and daily reports", () => {
  const guidance = buildStatusPreflightGuidance();
  expect(guidance).toContain('npm --prefix "');
  expect(guidance).toContain('run delegation:status:preflight -- "<report.json の絶対パス>"');
  expect(guidance).toContain("4000 UTF-16");
  expect(guidance).toContain("exit 0");
  expect(buildStatusReportGuidance("/status").join("\n")).toContain(guidance);
  expect(buildParttimerInject({ runId: "run", title: "日次", task: "作業", concordiaUrl: "http://localhost",
    mentionUserId: null, cwd: null, manual: null })).toContain(guidance);
});
