import { describe, expect, it } from "vitest";
import { resolveDeploymentTargets } from "./deployment-targets.js";

const hq = [{ kind: "discord" as const, target: "hq" }];
const child = (workflow: "revisor" | "github" | null, projects: string[] = ["Concordia"]) => resolveDeploymentTargets({
  project: "Concordia", hq, projectTargets: [{ kind: "discord", target: "project" }], workflow,
  subsidiaries: [{ subsidiaryId: "sub", enabled: true, projects, kind: "subsidiary-channel", target: "", intakeChannelId: "intake", botTokenEnc: "enc:v1:test" }],
});

describe("deployment target scope", () => {
  it("C-4 sends HQ for every project", () => expect(child(null).targets).toContainEqual(hq[0]));
  it("does not send to a subsidiary without project membership", () => expect(child("revisor", []).targets).toHaveLength(2));
  it("does not send to a github workflow subsidiary", () => expect(child("github").targets).toHaveLength(2));
  it("sends to a scoped revisor workflow subsidiary", () => expect(child("revisor").targets).toContainEqual(expect.objectContaining({ kind: "subsidiary-channel", target: "intake" })));
  it("fails closed while the workflow mirror is null", () => expect(child(null).targets).toHaveLength(2));
  it("deduplicates physical webhook destinations", () => expect(resolveDeploymentTargets({ project: "Concordia", hq, projectTargets: hq, workflow: "revisor", subsidiaries: [] }).targets).toEqual(hq));
});
