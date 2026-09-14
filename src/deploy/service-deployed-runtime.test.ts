import { describe, expect, it } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import type { SubsidiaryDeployNotifyRow, SubsidiaryRow } from "../db/subsidiary-repo.js";
import { createReleaseNoticeLookup } from "./release-published-runtime.js";
import { createDeploymentLookup } from "./service-deployed-runtime.js";

const HQ_ONLY = JSON.stringify({ enabled: true, hq: true, subsidiary_scope: "none", subsidiary_ids: [] });
const OFF = JSON.stringify({ enabled: false, hq: false, subsidiary_scope: "none", subsidiary_ids: [] });
const HQ_AND_ALL = JSON.stringify({ enabled: true, hq: true, subsidiary_scope: "all", subsidiary_ids: [] });

const HQ = { kind: "cc-channel" as const, target: "" };

function projectRow(overrides: Partial<ProjectCodeRow> = {}): ProjectCodeRow {
  return {
    code: "Di",
    project: "Discutere",
    repo_path: "E:/Document/Ars/Discutere",
    repo_origin: "https://github.com/LUDIARS/Discutere.git",
    domain_review: 0,
    github_issue_workflow: 0,
    deploy_notify: "[]",
    revisor_workflow: "revisor",
    added_by: "test",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

// sub-a は Discutere を通知対象に持ち自前の Bot を持つ。 sub-b は通知対象外で Bot 未設定。
const subsidiaries = {
  list: () => [
    { id: "sub-a", enabled: 1, channel_id: null, bot_token_enc: "enc:v1:a" },
    { id: "sub-b", enabled: 1, channel_id: null, bot_token_enc: null },
  ] as unknown as SubsidiaryRow[],
  listDeployProjects: (id: string) => (id === "sub-a" ? ["Discutere"] : []),
  listDeployNotify: (id: string): SubsidiaryDeployNotifyRow[] => [
    { subsidiary_id: id, kind: "subsidiary-channel", target: `channel-${id}`, enabled: 1 },
  ],
};

function lookups(row: ProjectCodeRow, subsidiaryRepo = subsidiaries) {
  const projects = { findByCode: () => row, list: () => [row], findByRepoOrigin: () => row };
  return {
    deploy: createDeploymentLookup({
      projects: projects as never,
      subsidiaries: subsidiaryRepo,
      excubitor: { findService: async () => null } as never,
      hqTargets: () => [HQ],
    }),
    release: createReleaseNoticeLookup({ projects, subsidiaries: subsidiaryRepo, hqTargets: () => [HQ] }),
  };
}

describe("project notification preferences at the runtime lookups", () => {
  it.each(["all", "selected", "operating"])("delivers %s to intake channels without registered notification targets", (scope) => {
    const policy = JSON.stringify({ enabled: true, hq: false, subsidiary_scope: scope, subsidiary_ids: ["sub-a"] });
    const repo = {
      ...subsidiaries,
      list: () => [
        { id: "sub-a", enabled: 1, channel_id: "intake-a", bot_token_enc: null },
        { id: "disabled", enabled: 0, channel_id: "intake-disabled", bot_token_enc: null },
      ] as unknown as SubsidiaryRow[],
      listDeployNotify: (): SubsidiaryDeployNotifyRow[] => [],
    };
    const { deploy, release } = lookups(projectRow({ deploy_notification: policy, release_notification: policy }), repo);
    const expected = [{ kind: "subsidiary-channel", target: "intake-a", subsidiaryId: "sub-a", botTokenEnc: null }];
    expect(deploy.findProject("Di")?.deploy_notify).toEqual(expected);
    expect(release.targets("LUDIARS/Discutere")).toEqual(expected);
    const legacy = lookups(projectRow(), repo);
    expect(legacy.deploy.findProject("Di")?.deploy_notify).toEqual([HQ]);
    expect(legacy.release.targets("LUDIARS/Discutere")).toEqual([HQ]);
  });

  it("deduplicates an intake channel also present in registered targets", () => {
    const repo = {
      ...subsidiaries,
      list: () => [{ id: "sub-a", enabled: 1, channel_id: "channel-sub-a", bot_token_enc: "enc:v1:a" }] as unknown as SubsidiaryRow[],
    };
    const { deploy, release } = lookups(projectRow({ deploy_notification: HQ_AND_ALL, release_notification: HQ_AND_ALL }), repo);
    const expected = [HQ, { kind: "subsidiary-channel", target: "channel-sub-a", subsidiaryId: "sub-a", botTokenEnc: "enc:v1:a" }];
    expect(deploy.findProject("Di")?.deploy_notify).toEqual(expected);
    expect(release.targets("LUDIARS/Discutere")).toEqual(expected);
  });

  it("suppresses a disabled deploy event while the release event keeps its own explicit scope", () => {
    const { deploy, release } = lookups(projectRow({ deploy_notification: OFF, release_notification: HQ_AND_ALL }));
    expect(deploy.findProject("Di")?.deploy_notify).toEqual([]);
    expect(release.targets("LUDIARS/Discutere")).toEqual([
      HQ,
      { kind: "subsidiary-channel", target: "channel-sub-a", subsidiaryId: "sub-a", botTokenEnc: "enc:v1:a" },
      { kind: "subsidiary-channel", target: "channel-sub-b", subsidiaryId: "sub-b", botTokenEnc: null },
    ]);
  });

  it("keeps the current rules for the event that has no explicit setting", () => {
    const { deploy, release } = lookups(projectRow({ release_notification: HQ_ONLY }));
    expect(deploy.findProject("Di")?.deploy_notify).toEqual([
      HQ,
      { kind: "subsidiary-channel", target: "channel-sub-a", subsidiaryId: "sub-a", botTokenEnc: "enc:v1:a" },
    ]);
    expect(release.targets("LUDIARS/Discutere")).toEqual([HQ]);
  });
});
