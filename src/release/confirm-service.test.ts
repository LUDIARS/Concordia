/**
 * 確認フローの状態機械。 git / ビルド / Excubitor は差し替えて、 遷移と排他切替の順序を検証する。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConfirmRunsRepo } from "../db/confirm-runs-repo.js";
import { ConfirmService } from "./confirm-service.js";
import type { ControlResult, ExcubitorClient, ServiceAction } from "../excubitor/client.js";
import * as gitOps from "./git-ops.js";
import * as build from "./build.js";

/** Excubitor の代役。 呼ばれた control の順序を記録する。 */
function makeExcubitor(overrides: {
  controlFails?: string[];
  alive?: boolean | null;
} = {}) {
  const calls: string[] = [];
  const client = {
    control: async (code: string, action: ServiceAction): Promise<ControlResult> => {
      calls.push(`${action}:${code}`);
      const ok = !(overrides.controlFails ?? []).includes(`${action}:${code}`);
      return { ok, action, exit_code: ok ? 0 : 1, stderr: ok ? "" : "boom" };
    },
    isAlive: async () => overrides.alive ?? true,
  } as unknown as ExcubitorClient;
  return { client, calls };
}

describe("ConfirmService", () => {
  let root: string;
  let repo: ConfirmRunsRepo;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concordia-confirm-"));
    // main / develop 両クローンが「存在する」ように見せる (clone-paths は .git の有無で判定)。
    for (const p of [join(root, "Concordia"), join(root, "develop", "Concordia")]) {
      mkdirSync(join(p, ".git"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    }
    repo = new ConfirmRunsRepo(makeTestDb());
    repo.createIfAbsent({
      repo_origin: "LUDIARS/Concordia",
      repo_name: "Concordia",
      service_code: "concordia",
      pr_number: 1,
      pr_title: "実装",
    });
    vi.spyOn(gitOps, "syncDevelopClone").mockResolvedValue({ ok: true, stdout: "abc1234def" });
    vi.spyOn(gitOps, "syncMainClone").mockResolvedValue({ ok: true, stdout: "main1234" });
    vi.spyOn(gitOps, "promoteDevelopToMain").mockResolvedValue({ ok: true, stdout: "abc1234def" });
    vi.spyOn(build, "buildClone").mockResolvedValue({ ok: true, ran: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const makeService = (excubitor: ExcubitorClient) =>
    new ConfirmService({
      repo,
      excubitor,
      resolveWorkspaceRoots: () => [root],
      sleep: async () => {},
    });

  it("start: main を止めてから develop を起動し、 confirming にする", async () => {
    const { client, calls } = makeExcubitor();
    const r = await makeService(client).start("concordia");

    expect(r.ok).toBe(true);
    // 同一ポートなので必ず stop → start の順。
    expect(calls).toEqual(["stop:concordia", "start:concordia-develop"]);
    expect(repo.listOpenForService("concordia")[0].status).toBe("confirming");
    expect(repo.listOpenForService("concordia")[0].develop_sha).toBe("abc1234def");
  });

  it("start: develop が起動しなければ main に戻して failed", async () => {
    const { client, calls } = makeExcubitor({ controlFails: ["start:concordia-develop"] });
    const r = await makeService(client).start("concordia");

    expect(r.ok).toBe(false);
    expect(calls).toEqual([
      "stop:concordia",
      "start:concordia-develop",   // 失敗
      "stop:concordia-develop",    // 切り戻し
      "start:concordia",
    ]);
    const row = repo.findByPr("LUDIARS/Concordia", 1)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("起動に失敗");
  });

  it("start: liveness が取れなければ main に戻して failed", async () => {
    const { client, calls } = makeExcubitor({ alive: false });
    const r = await makeService(client).start("concordia");

    expect(r.ok).toBe(false);
    expect(calls).toEqual(["stop:concordia", "start:concordia-develop", "stop:concordia-develop", "start:concordia"]);
    expect(repo.findByPr("LUDIARS/Concordia", 1)!.status).toBe("failed");
  });

  it("start: ビルド失敗ならサービスに触らない", async () => {
    vi.spyOn(build, "buildClone").mockResolvedValue({ ok: false, ran: true, error: "tsc error" });
    const { client, calls } = makeExcubitor();
    const r = await makeService(client).start("concordia");

    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);   // main を止めていない
    expect(repo.findByPr("LUDIARS/Concordia", 1)!.status).toBe("failed");
  });

  it("ok: main へ ff 反映 → develop を止めて main を起動 → confirmed", async () => {
    const { client, calls } = makeExcubitor();
    const service = makeService(client);
    await service.start("concordia");
    calls.length = 0;

    const r = await service.ok("concordia");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["stop:concordia-develop", "start:concordia"]);
    expect(repo.findByPr("LUDIARS/Concordia", 1)!.status).toBe("confirmed");
    expect(repo.listOpen()).toEqual([]);
  });

  it("ok: main が分岐していて ff できなければ反映せず failed", async () => {
    vi.spyOn(gitOps, "promoteDevelopToMain").mockResolvedValue({
      ok: false, stdout: "", error: "main が develop から分岐しています",
    });
    const { client, calls } = makeExcubitor();
    const service = makeService(client);
    await service.start("concordia");
    calls.length = 0;

    const r = await service.ok("concordia");
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);   // 起動系には触らない (develop 版が動いたまま)
    expect(repo.findByPr("LUDIARS/Concordia", 1)!.status).toBe("failed");
  });

  it("ng: main に戻し、 確認は pending へ差し戻す", async () => {
    const { client, calls } = makeExcubitor();
    const service = makeService(client);
    await service.start("concordia");
    calls.length = 0;

    const r = await service.ng("concordia", "表示が崩れる");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["stop:concordia-develop", "start:concordia"]);
    const row = repo.findByPr("LUDIARS/Concordia", 1)!;
    expect(row.status).toBe("pending");
    expect(row.error).toBe("表示が崩れる");
  });

  it("start: 確認待ちが無ければ何もしない", async () => {
    const { client, calls } = makeExcubitor();
    const r = await makeService(client).start("memoria-server");
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
