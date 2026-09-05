import { describe, expect, it } from "vitest";

import { launchDelegationProcess, type DelegationSpawner } from "./launcher.js";
import type { SpawnRequest } from "../control/spawner.js";
import type { DelegationDefinition, InvokeInput } from "./contracts.js";

const DEFINITION: DelegationDefinition = {
  template_id: "tpl-1",
  call_name: "opus-mid",
  title: "実装委託 (Opus / mid)",
  target_provider: "claude",
  model: "claude-opus-5",
  prompt_template: "",
  input_schema: "[]",
  default_cwd: null,
  category: "employee",
};

const INVOCATION: InvokeInput = { call_name: "opus-mid", args: {} };

function capture(): { spawner: DelegationSpawner; requests: SpawnRequest[] } {
  const requests: SpawnRequest[] = [];
  return {
    requests,
    spawner: (req) => {
      requests.push(req);
      return { ok: true, pid: 1234, command: ["wt.exe"] };
    },
  };
}

function launch(startedAt?: string): SpawnRequest {
  const { spawner, requests } = capture();
  launchDelegationProcess({
    runId: "run-1",
    definition: DEFINITION,
    invocation: INVOCATION,
    logicalProvider: "claude",
    spawnProvider: "claude",
    spawnArgs: [],
    effectiveModel: "claude-opus-5",
    effectiveOptions: {},
    branch: "feat/x",
    promptPath: "prompts/run-1.md",
    startupInjectText: "",
    startedAt,
    spawner,
  });
  return requests[0]!;
}

/**
 * 受託側は `augur contracts report --since $DELEGATION_STARTED_AT` で受け入れ条件を
 * 集計する (spec/feature/task-workflow.md §5.1)。 起点を子が自分で決めると、 前回 run の
 * 記録まで拾って「通ったことになる」ので、 Concordia が env で渡す。
 */
describe("launchDelegationProcess — DELEGATION_STARTED_AT", () => {
  it("委託開始時刻を UTC ISO 8601 で子の env に渡す", () => {
    const request = launch("2026-09-05T01:02:03.000Z");
    expect(request.env?.DELEGATION_STARTED_AT).toBe("2026-09-05T01:02:03.000Z");
  });

  it("未指定なら起動時刻を ISO 8601 で埋める", () => {
    const request = launch();
    const value = request.env?.DELEGATION_STARTED_AT ?? "";
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(value))).toBe(false);
  });

  it("既存の run id / prompt file の受け渡しは変わらない", () => {
    const request = launch("2026-09-05T00:00:00.000Z");
    expect(request.env?.CONCORDIA_DELEGATION_RUN_ID).toBe("run-1");
    expect(request.env?.CONCORDIA_DELEGATION_PROMPT_FILE).toBe("prompts/run-1.md");
  });
});
