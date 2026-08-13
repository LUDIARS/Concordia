/**
 * 第2段階配信の冪等性テスト。
 *
 * 「初回と follow-up の重複、再起動、再送は冪等に扱う」 が要求なので、 同じ report を
 * 何度投げても実装タスクは 1 度しか届かないことを、 repo の NULL ガードを模した
 * fake で確認する (実 DB 越しの確認は api/delegation-staged-injection.test.ts)。
 */
import { describe, it, expect, vi } from "vitest";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import { deliverStagedFollowup, type StagedFollowupRunsRepo } from "./staged-followup.js";

function makeRun(overrides: Partial<DelegationRunRow> = {}): DelegationRunRow {
  return {
    id: "run-1",
    template_id: null,
    call_name: "claude-opus-5-impl",
    target_provider: "claude",
    parent_session_id: null,
    child_session_id: "sess-1",
    args_json: JSON.stringify({ task: "段階注入" }),
    rendered_prompt: "段階注入を実装する",
    prompt_file_path: "E:/tmp/run-1.md",
    spawn_pid: 1,
    spawn_command: null,
    triggered_by: null,
    status: "running",
    error: null,
    queue_payload_json: null,
    spawn_cwd: "E:/repo",
    spawn_branch: "feat/staged",
    staged_injection: 1,
    staged_followup_at: null,
    memoria_task_id: null,
    memoria_task_url: null,
    created_at: 1,
    ...overrides,
  } as DelegationRunRow;
}

/** delegation_runs の NULL ガード付き UPDATE を模した fake。 */
function makeRepo(initial: DelegationRunRow): StagedFollowupRunsRepo & { row: DelegationRunRow } {
  const state = { row: initial };
  return {
    get row() { return state.row; },
    findRun: () => state.row,
    recordInvestigationReport(_id, summary) {
      state.row = { ...state.row, investigation_summary: summary };
    },
    recordMemoriaTask(_id, taskId, taskUrl) {
      if (state.row.memoria_task_id) return false;
      state.row = { ...state.row, memoria_task_id: taskId, memoria_task_url: taskUrl };
      return true;
    },
    markStagedFollowupDelivered(_id, nowMs) {
      if (state.row.staged_followup_at != null) return false;
      state.row = { ...state.row, staged_followup_at: nowMs };
      return true;
    },
  };
}

const memoriaOk = () => ({
  createTask: vi.fn(async () => ({ id: 42 })),
  taskApiUrl: (id: string | number) => `http://127.0.0.1:5180/api/tasks/${id}`,
});

const REPORT = { summary: "現行実装はこうなっている", files: ["src/a.ts"], blockers: [] };
const CONCORDIA_URL = "http://127.0.0.1:11111";

describe("deliverStagedFollowup", () => {
  it("段階注入でない run は拒否する (タスクは初回で配信済み)", async () => {
    const repo = makeRepo(makeRun({ staged_injection: 0 }));
    const outcome = await deliverStagedFollowup("run-1", REPORT, {
      runs: repo, memoria: memoriaOk(), inject: vi.fn(), concordiaUrl: CONCORDIA_URL,
    });
    expect(outcome).toEqual({ ok: false, error: "run_not_staged" });
  });

  it("初回は Memoria タスクを作り、実装タスクを 1 通配信する", async () => {
    const repo = makeRepo(makeRun());
    const inject = vi.fn();
    const memoria = memoriaOk();
    const outcome = await deliverStagedFollowup("run-1", REPORT, {
      runs: repo, memoria, inject, concordiaUrl: CONCORDIA_URL,
    });
    expect(outcome).toMatchObject({ ok: true, delivered: true, already_delivered: false, memoria_created: true });
    expect(memoria.createTask).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledTimes(1);
    const [text, source] = inject.mock.calls[0];
    expect(source).toBe("followup");
    expect(text).toContain("段階注入を実装する");
    expect(text).toContain("- id: 42");
    expect(repo.row.staged_followup_at).not.toBeNull();
    expect(repo.row.investigation_summary).toContain("現行実装はこうなっている");
  });

  it("2 回目以降の報告では実装タスクを再配信せず Memoria も作り直さない", async () => {
    const repo = makeRepo(makeRun());
    const inject = vi.fn();
    const memoria = memoriaOk();
    const deps = { runs: repo, memoria, inject, concordiaUrl: CONCORDIA_URL };
    await deliverStagedFollowup("run-1", REPORT, deps);
    const second = await deliverStagedFollowup("run-1", REPORT, deps);
    expect(second).toMatchObject({ ok: true, delivered: false, already_delivered: true, supplement_delivered: false });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(memoria.createTask).toHaveBeenCalledTimes(1);
  });

  it("args に既存の Memoria task id があれば新規作成せず関連付ける", async () => {
    const repo = makeRepo(makeRun({ args_json: JSON.stringify({ memoria_task_id: 777 }) }));
    const memoria = memoriaOk();
    const outcome = await deliverStagedFollowup("run-1", REPORT, {
      runs: repo, memoria, inject: vi.fn(), concordiaUrl: CONCORDIA_URL,
    });
    expect(memoria.createTask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: true, delivered: true });
    expect(repo.row.memoria_task_id).toBe("777");
  });

  it("Memoria が落ちていても実装タスクは配信し、未作成の理由を本文に残す", async () => {
    const repo = makeRepo(makeRun());
    const inject = vi.fn();
    const outcome = await deliverStagedFollowup("run-1", REPORT, {
      runs: repo,
      memoria: {
        createTask: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }),
        taskApiUrl: (id: string | number) => `http://127.0.0.1:5180/api/tasks/${id}`,
      },
      inject,
      concordiaUrl: CONCORDIA_URL,
    });
    expect(outcome).toMatchObject({ ok: true, delivered: true, memoria_created: false });
    expect(outcome.ok && outcome.memoria_error).toContain("ECONNREFUSED");
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0][0]).toContain("未作成: connect ECONNREFUSED");
  });

  it("配信後に Memoria が復旧したら id だけ補足し、実装タスクは再送しない", async () => {
    const repo = makeRepo(makeRun());
    const inject = vi.fn();
    const failing = {
      createTask: vi.fn(async () => { throw new Error("down"); }),
      taskApiUrl: (id: string | number) => `http://127.0.0.1:5180/api/tasks/${id}`,
    };
    await deliverStagedFollowup("run-1", REPORT, {
      runs: repo, memoria: failing, inject, concordiaUrl: CONCORDIA_URL,
    });
    const recovered = await deliverStagedFollowup("run-1", REPORT, {
      runs: repo, memoria: memoriaOk(), inject, concordiaUrl: CONCORDIA_URL,
    });
    expect(recovered).toMatchObject({ ok: true, delivered: false, supplement_delivered: true });
    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject.mock.calls[1][1]).toBe("followup-memoria");
    expect(inject.mock.calls[1][0]).not.toContain("### 完了条件");
  });

  it("Memoria 未注入でも実装タスクは配信する (追跡タスク無しを明示)", async () => {
    const repo = makeRepo(makeRun());
    const inject = vi.fn();
    const outcome = await deliverStagedFollowup("run-1", REPORT, {
      runs: repo, inject, concordiaUrl: CONCORDIA_URL,
    });
    expect(outcome).toMatchObject({ ok: true, delivered: true });
    expect(inject.mock.calls[0][0]).toContain("未作成: memoria client is not configured");
  });
});
