import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConfirmRunsRepo } from "../db/confirm-runs-repo.js";
import { intakeDevelopMerge } from "./confirm-intake.js";
import type { MemoriaClient, MemoriaTask } from "../memoria/client.js";

function makeMemoria(fail = false) {
  const created: string[] = [];
  const client = {
    createTask: async (input: { title: string }): Promise<MemoriaTask> => {
      if (fail) throw new Error("memoria down");
      created.push(input.title);
      return { id: 700 + created.length, title: input.title, status: "todo" };
    },
    completeTask: async () => {},
  } as unknown as MemoriaClient;
  return { client, created };
}

describe("intakeDevelopMerge", () => {
  let repo: ConfirmRunsRepo;

  const event = {
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    pr_title: "窓口とキュー",
    pr_url: "https://github.com/LUDIARS/Concordia/pull/42",
  };

  beforeEach(() => {
    repo = new ConfirmRunsRepo(makeTestDb());
  });

  it("初回は確認待ちを作り、 Memoria に確認タスクを積む", async () => {
    const memoria = makeMemoria();
    const r = await intakeDevelopMerge(
      { repo, memoria: memoria.client, resolveServiceCode: async () => "concordia" },
      event,
    );

    expect(r.created).toBe(true);
    expect(r.row.status).toBe("pending");
    expect(r.row.service_code).toBe("concordia");
    expect(r.row.memoria_task_id).toBe(701);
    expect(memoria.created[0]).toContain("[確認] Concordia #42");
  });

  it("同じ merge を再観測しても二重に積まない (reconcile は毎周期観測する)", async () => {
    const memoria = makeMemoria();
    const deps = { repo, memoria: memoria.client, resolveServiceCode: async () => "concordia" };
    await intakeDevelopMerge(deps, event);
    const second = await intakeDevelopMerge(deps, event);

    expect(second.created).toBe(false);
    expect(memoria.created).toHaveLength(1);
    expect(repo.listOpen()).toHaveLength(1);
  });

  it("Memoria が落ちていても確認待ちは Cc 側に残る", async () => {
    const memoria = makeMemoria(true);
    const r = await intakeDevelopMerge(
      { repo, memoria: memoria.client, resolveServiceCode: async () => "concordia" },
      event,
    );

    expect(r.created).toBe(true);
    expect(r.row.memoria_task_id).toBeNull();
    expect(repo.listOpen()).toHaveLength(1);
  });

  it("起動を伴わないリポは service_code が null", async () => {
    const memoria = makeMemoria();
    const r = await intakeDevelopMerge(
      { repo, memoria: memoria.client, resolveServiceCode: async () => null },
      { ...event, repo_origin: "LUDIARS/AIFormat", pr_number: 7 },
    );

    expect(r.row.service_code).toBeNull();
    expect(memoria.created[0]).toContain("AIFormat");
  });
});
