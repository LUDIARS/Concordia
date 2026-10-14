/**
 * バグ報告の案内 (spec/feature/bug-bounty.md §8.1 §16.6 §18.5) の回帰確認。
 * クラシファイアは通常のバグ報告 (bug-report) の経路を示し、開催中の企画があるときだけ企画の経路を併記する。
 * 起動時の共通案内は経路と節度を 1 行で伝え、開催中の企画ごとに 1 行添える。
 */

import { describe, expect, it } from "vitest";
import { BUG_REPORT_STARTUP_LINE, buildSharedStartupContext } from "../src/control/shared-startup-context.js";
import { workflowContext, workflowGuidance } from "../src/harness/reliability/workflow-guidance.js";
import type { OpenBountyEventNotice } from "../src/shared/bounty-event-notice.js";

/** 不具合の報告の案内 (bug-report)。 判定の合図は §16.6 のまま。 */
const report = (prompt: string) => workflowGuidance(prompt).filter((route) => route.kind === "bug-report");

const EVENT: OpenBountyEventNotice = {
  id: "be_a", title: "秋のバグ探し", startsAt: Date.UTC(2026, 9, 14, 0, 0), endsAt: Date.UTC(2026, 9, 21, 0, 0),
  projects: ["Cc", "Ar"], guidance: "通知まわりを重点的に",
};

describe("workflowGuidance: bug-report", () => {
  it.each([
    "Excubitor の再起動でバグを見つけたんだけど、どこに報告すればいい?",
    "通知が動かない不具合を報告したい",
    "この壊れているやつ、バウンティに出せる?",
    "I found a bug in the deploy notice, where do I report it?",
  ])("routes %j to the ordinary report skill", (prompt) => {
    const routes = report(prompt);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ skill: "bug-report", services: ["Actio"], source: "deterministic" });
    expect(routes[0]!.advice).toContain("bug-report スキルで Actio");
    // 開催中の企画が無ければ、バウンティと書かれていても企画の経路は出さない。
    expect(workflowGuidance(prompt).some((route) => route.kind === "bug-bounty")).toBe(false);
  });

  it("only shows the route: the advice says the report is not filed automatically and states the restraint", () => {
    const advice = report("バグを見つけたので報告したい")[0]!.advice;
    expect(advice).toContain("報告は自動で出さない");
    expect(advice).toContain("自分の作業で直すものは報告せず");
    expect(advice).toContain("同じ不具合を繰り返し報告せず");
    expect(advice).toContain("調査範囲を広げない");
    expect(workflowContext(report("バグを見つけたので報告したい"))).toContain("routing only, no added authorization");
  });

  it.each([
    "バグを見つけたけど報告しないでおく",
    "この不具合の報告は不要です",
    "不具合を見つけた。報告はしなくていい",
  ])("stays quiet when the human declines to report: %j", (prompt) => {
    expect(workflowGuidance(prompt, [], { openBountyEvents: [EVENT] })).toEqual([]);
  });

  it.each([
    "[自動確認] バグを見つけたら報告してください",
    "[Cc Session policy]\n不具合を見つけたら報告できます",
    "[Cc policy update]\n不具合を見つけたら bug-bounty-report で報告できます",
  ])("ignores automatic confirmations and policy notices: %j", (prompt) => {
    expect(workflowGuidance(prompt, [], { openBountyEvents: [EVENT] })).toEqual([]);
  });

  it.each([
    "このバグを直して、終わったら報告して",
    "不具合を修正して結果を報告",
    "debug して report して",
    "debugging の結果を report にまとめて",
    "バグを見つけたので直して",
    "バウンティの受付のバグを修正して",
    "I found the bug, please fix it",
  ])("stays quiet for a fix request or a work report: %j", (prompt) => {
    expect(workflowGuidance(prompt, [], { openBountyEvents: [EVENT] }).filter((route) => route.kind.startsWith("bug-"))).toEqual([]);
  });

  it.each([
    "bug-bounty-report の使い方を教えて",
    "これ /bug で出せる?",
    "バグを見つけた。直してほしいけど、まずどこに報告すればいい?",
  ])("routes an explicit bounty mention or a wish to report even next to other requests: %j", (prompt) => {
    expect(report(prompt)).toHaveLength(1);
  });

  it("ignores text inside a code block and a defect mentioned without finding or reporting it", () => {
    expect(report("ログです:\n```\nバグを見つけたので報告します\n```\n続けてください")).toEqual([]);
    expect(report("このバグを直して")).toEqual([]);
    expect(report("進捗を報告して")).toEqual([]);
  });

  it("adds the bounty route next to bug-report only while an event is open", () => {
    const routes = workflowGuidance("通知が動かない不具合を報告したい", [], { openBountyEvents: [EVENT] });
    expect(routes.map((route) => route.kind)).toEqual(["bug-report", "bug-bounty"]);
    expect(routes[1]).toMatchObject({ skill: "bug-bounty-report", services: ["Concordia"], source: "deterministic" });
    const advice = routes[1]!.advice;
    expect(advice).toContain("秋のバグ探し");
    expect(advice).toContain("2026/10/14 09:00〜2026/10/21 09:00 JST");
    expect(advice).toContain("対象: Cc, Ar");
    expect(advice).toContain("通知まわりを重点的に");
    expect(advice).toContain("POST /v1/bounty/reports");
    expect(advice).toContain("/bug");
    expect(advice).toContain("報告は自動で出さない");
    // 対象プロジェクトが分かる経路では、その対象を含む企画だけ。
    expect(workflowGuidance("通知が動かない不具合を報告したい", [], { openBountyEvents: [EVENT], project: "At" })
      .map((route) => route.kind)).toEqual(["bug-report"]);
    expect(workflowGuidance("通知が動かない不具合を報告したい", [], { openBountyEvents: [EVENT], project: "cc" })
      .map((route) => route.kind)).toEqual(["bug-report", "bug-bounty"]);
  });

  it("keeps the existing routes intact", () => {
    expect(workflowGuidance("この機能の実装を調査して").map((route) => route.kind)).toEqual(["feature-investigation"]);
  });
});

describe("shared startup context", () => {
  const input = {
    repoPath: "E:/fixture/project", projectRoot: "E:/fixture/project", workspaceRoots: ["E:/fixture"],
    readableFile: async () => true,
  };

  it("adds one line with the ordinary report route and the restraint, and no bounty line without an event", async () => {
    const text = await buildSharedStartupContext(input);
    expect(text.split("\n").filter((line) => line.includes("bug-report"))).toEqual([BUG_REPORT_STARTUP_LINE]);
    expect(text).not.toContain("bug-bounty-report");
    expect(BUG_REPORT_STARTUP_LINE).toContain("作業の範囲外で仕組みの不具合を見つけたら `bug-report` スキルで Actio に登録");
    expect(BUG_REPORT_STARTUP_LINE).toContain("自分の作業で直すものは報告せず");
    expect(BUG_REPORT_STARTUP_LINE).toContain("同じ不具合を繰り返し報告せず");
    expect(BUG_REPORT_STARTUP_LINE).toContain("調査範囲を広げないでください");
    expect(BUG_REPORT_STARTUP_LINE).toContain("報告は自動で出しません");
  });

  it("adds one line per open event with its title, period, targets and route", async () => {
    const text = await buildSharedStartupContext({ ...input, openBountyEvents: [EVENT] });
    const lines = text.split("\n").filter((line) => line.includes("bug-bounty-report"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("秋のバグ探し");
    expect(lines[0]).toContain("2026/10/14 09:00〜2026/10/21 09:00 JST");
    expect(lines[0]).toContain("対象: Cc, Ar");
    expect(lines[0]).toContain("`POST /v1/bounty/reports`");
    expect(lines[0]).toContain("`/bug`");
  });
});
