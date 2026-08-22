import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { DEPLOY_CLAIM_SESSION_ID, deployAfterCheckoutPublish } from "./deploy-service.js";

function workspaceWithRepo(repoName: string): string {
  const root = mkdtempSync(join(tmpdir(), "cc-deploy-"));
  mkdirSync(join(root, repoName, ".git"), { recursive: true });
  return root;
}

function makeDeps(overrides: Partial<Parameters<typeof deployAfterCheckoutPublish>[0]> = {}) {
  const controls: Array<{ code: string; action: string }> = [];
  const claims = new TestingClaimsRepo(makeTestDb());
  const deps = {
    resolveServiceCode: async () => "concordia",
    resolveWorkspaceRoots: () => [workspaceWithRepo("Concordia")],
    excubitor: {
      control: async (code: string, action: "restart") => {
        controls.push({ code, action });
        return { ok: true, action, exit_code: 0 };
      },
    },
    claims,
    build: async () => ({ ok: true, ran: true }),
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, controls, claims };
}

describe("checkout 前進後の deploy", () => {
  it("サービスがあれば build して Excubitor 経由で再起動し、claim を解放する", async () => {
    const { deps, controls, claims } = makeDeps();
    const outcome = await deployAfterCheckoutPublish(deps, { repository: "LUDIARS/Concordia", sha: "cd190cb" });

    expect(outcome).toEqual({ kind: "deployed", repository: "Concordia", serviceCode: "concordia", built: true });
    expect(controls).toEqual([{ code: "concordia", action: "restart" }]);
    expect(claims.listActive(1_000)).toEqual([]);
  });

  it("Excubitor 登録のサービスが無いリポでは何もしない", async () => {
    const { deps, controls } = makeDeps({ resolveServiceCode: async () => null });
    const outcome = await deployAfterCheckoutPublish(deps, { repository: "Lapilli" });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "no_service" });
    expect(controls).toEqual([]);
  });

  it("本体クローンが見つからなければ起動しない (worktree からは起動しない)", async () => {
    const { deps, controls } = makeDeps({ resolveWorkspaceRoots: () => [mkdtempSync(join(tmpdir(), "cc-empty-"))] });
    const outcome = await deployAfterCheckoutPublish(deps, { repository: "Concordia" });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "no_main_clone" });
    expect(controls).toEqual([]);
  });

  it("他セッションが同じサービスをテスト中なら見送り、claim を残さない", async () => {
    const { deps, controls, claims } = makeDeps();
    claims.claim({ service: "concordia", session_id: "other", now: 1_000 });

    const outcome = await deployAfterCheckoutPublish(deps, { repository: "Concordia" });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "claim_conflict" });
    expect(controls).toEqual([]);
    expect(claims.listActive(1_000).map((claim) => claim.session_id)).toEqual(["other"]);
  });

  it("build に失敗したら再起動せず、失敗として返す (巻き戻さない)", async () => {
    const { deps, controls, claims } = makeDeps({ build: async () => ({ ok: false, ran: true, error: "tsc failed" }) });
    const outcome = await deployAfterCheckoutPublish(deps, { repository: "Concordia" });

    expect(outcome).toMatchObject({ kind: "failed", stage: "build", detail: "tsc failed" });
    expect(controls).toEqual([]);
    expect(claims.listActive(1_000).filter((claim) => claim.session_id === DEPLOY_CLAIM_SESSION_ID)).toEqual([]);
  });

  it("再起動に失敗したら restart 段階の失敗として返す", async () => {
    const { deps } = makeDeps({
      excubitor: {
        control: async (_code: string, action: "restart") => ({ ok: false, action, exit_code: 1, stderr: "port busy" }),
      },
    });
    const outcome = await deployAfterCheckoutPublish(deps, { repository: "Concordia" });

    expect(outcome).toMatchObject({ kind: "failed", stage: "restart", detail: "port busy" });
  });

  it("リポジトリを特定できない通知では deploy しない", async () => {
    const { deps, controls } = makeDeps();
    const outcome = await deployAfterCheckoutPublish(deps, { repository: null });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "no_repository" });
    expect(controls).toEqual([]);
  });

  it("パス片として危険なリポ名では workspace 外を触らない", async () => {
    // 通知本文は外部由来。 `..` を素通しすると workspace root の外を本体クローンとみなす。
    const resolved: string[] = [];
    const { deps, controls } = makeDeps({
      resolveServiceCode: async (name: string) => {
        resolved.push(name);
        return "concordia";
      },
    });

    for (const repository of ["..", "../Concordia", "C:/Windows"]) {
      const outcome = await deployAfterCheckoutPublish(deps, { repository });
      expect(outcome).toMatchObject({ kind: "skipped", reason: "no_repository" });
    }
    // 危険名はサービス解決にも到達しない (= クローン探索も再起動も走らない)。
    expect(resolved).toEqual([]);
    expect(controls).toEqual([]);
  });

  it("同じサービスへの連続 deploy を直列化する (build が重ならない / claim を奪い合わない)", async () => {
    // watch の重複抑止は repo+sha 単位なので、別 sha の連続マージは並走しうる。
    let active = 0;
    let overlapped = false;
    const { deps, controls } = makeDeps({
      build: async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, ran: true };
      },
    });

    const outcomes = await Promise.all([
      deployAfterCheckoutPublish(deps, { repository: "Concordia", sha: "aaaaaaa" }),
      deployAfterCheckoutPublish(deps, { repository: "Concordia", sha: "bbbbbbb" }),
    ]);

    expect(overlapped).toBe(false);
    // 直列なので後発も claim 衝突扱いにならず、2 本とも成立する。
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["deployed", "deployed"]);
    expect(controls).toEqual([
      { code: "concordia", action: "restart" },
      { code: "concordia", action: "restart" },
    ]);
  });
});
