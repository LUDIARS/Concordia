import { describe, expect, it } from "vitest";
import { resolveDeploymentTargets } from "./deployment-targets.js";
import type { ProjectNotificationPolicy } from "./notification-target-policy.js";

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

const policy = (overrides: Partial<ProjectNotificationPolicy> = {}): ProjectNotificationPolicy => ({
  enabled: true, hq: true, subsidiaryScope: "none", subsidiaryIds: [], ...overrides,
});
const candidates = [
  { subsidiaryId: "operating", enabled: true, projects: ["Concordia"], kind: "subsidiary-channel" as const, target: "", intakeChannelId: "intake-operating", botTokenEnc: null },
  { subsidiaryId: "other", enabled: true, projects: ["Pagus"], kind: "subsidiary-channel" as const, target: "channel-other", intakeChannelId: null, botTokenEnc: "enc:v1:other" },
  { subsidiaryId: "stopped", enabled: false, projects: ["Concordia"], kind: "slack" as const, target: "stopped-slack", intakeChannelId: null, botTokenEnc: null },
];
const explicit = (value: ProjectNotificationPolicy) => resolveDeploymentTargets({
  project: "Concordia", hq, projectTargets: [{ kind: "discord", target: "project" }], workflow: null, subsidiaries: candidates, policy: value,
}).targets;
const subsidiaryIds = (targets: ReturnType<typeof explicit>) => targets.flatMap((target) => (target.subsidiaryId ? [target.subsidiaryId] : []));

describe("explicit project notification policy", () => {
  it("delivers nothing, not even HQ, while the event is disabled", () => expect(explicit(policy({ enabled: false, subsidiaryScope: "all" }))).toEqual([]));
  it("omits HQ when HQ delivery is unchecked", () => expect(explicit(policy({ hq: false }))).toEqual([{ kind: "discord", target: "project" }]));
  it("sends operating subsidiaries by notification project membership without the workflow mirror", () =>
    expect(subsidiaryIds(explicit(policy({ subsidiaryScope: "operating" })))).toEqual(["operating"]));
  it("sends every enabled subsidiary for the all scope", () => {
    const targets = explicit(policy({ subsidiaryScope: "all" }));
    expect(subsidiaryIds(targets)).toEqual(["operating", "other"]);
    expect(targets).not.toContainEqual({ kind: "slack", target: "stopped-slack" });
  });
  it("sends only selected subsidiaries that are registered and enabled", () => {
    const targets = explicit(policy({ subsidiaryScope: "selected", subsidiaryIds: ["other", "stopped", "removed"] }));
    expect(subsidiaryIds(targets)).toEqual(["other"]);
    expect(targets).not.toContainEqual({ kind: "slack", target: "stopped-slack" });
  });
  it("keeps a subsidiary channel without its own bot token for the HQ bot fallback", () =>
    expect(explicit(policy({ subsidiaryScope: "operating" })))
      .toContainEqual({ kind: "subsidiary-channel", target: "intake-operating", subsidiaryId: "operating", botTokenEnc: null }));
  it("deduplicates HQ, project and subsidiary destinations", () => expect(resolveDeploymentTargets({
    project: "Concordia", hq, projectTargets: hq, workflow: null, policy: policy({ subsidiaryScope: "operating" }),
    subsidiaries: [{ subsidiaryId: "dup", enabled: true, projects: ["Concordia"], kind: "discord", target: "hq", intakeChannelId: null, botTokenEnc: null }],
  }).targets).toEqual(hq));
});
