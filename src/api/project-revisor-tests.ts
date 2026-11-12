import { Hono } from "hono";
import { z } from "zod";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type {
  RevisorRepositoryAdmin,
  RevisorRepositoryTestCase,
} from "../pr/revisor-repository-client.js";
import { findRevisorRecord, listRevisorRepositories } from "./project-revisor-record.js";

// @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01)
//
// Revisor の登録テスト (test_cases) を 1 件ずつ足し引きする。 Revisor の登録 API は全項目の
// upsert なので、 既存の登録を読み直して対象の 1 件だけ変えたものを送り返す。

/** Revisor の上限 (local-contracts.mjs の test_cases 検証) と揃える。 */
const MAX_TEST_CASES = 32;
/** Revisor の SAFE_COMMAND_PART と同じ。 シェル展開に使われうる文字を Cc の入口で止める。 */
const SAFE_COMMAND_PART = /^[^\0\r\n"&|<>^%!]*$/;
/** Revisor の change-classification.mjs CHANGE_KINDS と同じ。 */
const CHANGE_KINDS = ["code", "docs", "test", "config", "infra", "asset", "generated"] as const;

const SafePart = (max: number) => z.string().max(max).regex(SAFE_COMMAND_PART);

const TestCaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  command: SafePart(260).trim().min(1),
  args: z.array(SafePart(1_000)).max(64).default([]),
  cwd: z.string().trim().min(1).max(1_000)
    .refine((cwd) => isRepositoryRelative(cwd), { message: "cwd must stay inside the repository" })
    .default("."),
  timeout_ms: z.number().int().min(1_000).max(60 * 60_000).default(10 * 60_000),
  kinds: z.array(z.enum(CHANGE_KINDS)).min(1).max(CHANGE_KINDS.length).nullable().default(null),
  runtime: z.boolean().default(false),
  always: z.boolean().default(false),
}).strict();

export interface ProjectRevisorTestsRouterDeps {
  repo: Pick<ProjectCodesRepo, "findByCode">;
  revisor: Pick<RevisorRepositoryAdmin, "listRepositories" | "setRepositoryTestCases">;
  /** 登録を書き換えた後に呼ぶ (一覧キャッシュの破棄)。 */
  onChanged?: () => void;
}

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
export function projectRevisorTestsRouter(deps: ProjectRevisorTestsRouterDeps): Hono {
  const app = new Hono();

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
  app.get("/:code/revisor-tests", async (c) => {
    const found = await resolveRecord(deps, c.req.param("code"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    return c.json({
      repository: found.record.repository,
      test_cases: found.record.testCases.map(toResponseTestCase),
    });
  });

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
  app.post("/:code/revisor-tests", async (c) => {
    const parsed = TestCaseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_revisor_test_case", detail: parsed.error.flatten() }, 400);
    }
    const found = await resolveRecord(deps, c.req.param("code"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const { record } = found;
    if (record.testCases.some((testCase) => testCase.name === parsed.data.name)) {
      return c.json({ error: "revisor_test_case_exists" }, 409);
    }
    if (record.testCases.length >= MAX_TEST_CASES) {
      return c.json({ error: "revisor_test_case_limit" }, 409);
    }
    const added: RevisorRepositoryTestCase = {
      name: parsed.data.name,
      command: parsed.data.command,
      args: parsed.data.args,
      cwd: parsed.data.cwd,
      timeoutMs: parsed.data.timeout_ms,
      kinds: parsed.data.kinds,
      runtime: parsed.data.runtime,
      always: parsed.data.always,
    };
    const next = [...record.testCases, added];
    if (!await save(deps, record, next)) return c.json({ error: "revisor_test_cases_update_failed" }, 502);
    return c.json({ ok: true, test_cases: next.map(toResponseTestCase) }, 201);
  });

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
  app.delete("/:code/revisor-tests/:name", async (c) => {
    const name = c.req.param("name");
    const found = await resolveRecord(deps, c.req.param("code"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const { record } = found;
    if (!record.testCases.some((testCase) => testCase.name === name)) {
      return c.json({ error: "revisor_test_case_not_found" }, 404);
    }
    // Revisor は登録テスト 0 件の登録を受け付けない。 最後の 1 件は消せないと先に返す。
    if (record.testCases.length <= 1) return c.json({ error: "revisor_test_case_last" }, 409);
    const next = record.testCases.filter((testCase) => testCase.name !== name);
    if (!await save(deps, record, next)) return c.json({ error: "revisor_test_cases_update_failed" }, 502);
    return c.json({ ok: true, test_cases: next.map(toResponseTestCase) });
  });

  return app;
}

type ResolvedRecord =
  | { record: Awaited<ReturnType<RevisorRepositoryAdmin["listRepositories"]>>[number] }
  | { error: string; status: 404 | 409 | 502 };

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
async function resolveRecord(deps: ProjectRevisorTestsRouterDeps, code: string): Promise<ResolvedRecord> {
  const row = deps.repo.findByCode(code);
  if (!row) return { error: "project_code_not_found", status: 404 };
  // 書き換えは古い一覧からの round-trip で他の変更を消さないよう、 キャッシュを使わず毎回読む。
  const repos = await listRevisorRepositories(deps.revisor);
  if (!repos.list) return { error: "revisor_unreachable", status: 502 };
  const record = findRevisorRecord(repos.list, row);
  if (!record) return { error: "revisor_not_registered", status: 409 };
  return { record };
}

/**
 * Revisor のエラー本文はブラウザへ返さない (spec: 未検証データを素通ししない)。
 * @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01)
 */
async function save(
  deps: ProjectRevisorTestsRouterDeps,
  record: Parameters<RevisorRepositoryAdmin["setRepositoryTestCases"]>[0],
  testCases: RevisorRepositoryTestCase[],
): Promise<boolean> {
  const saved = await deps.revisor.setRepositoryTestCases(record, testCases).then(() => true, () => false);
  if (saved) deps.onChanged?.();
  return saved;
}

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
function toResponseTestCase(testCase: RevisorRepositoryTestCase) {
  return {
    name: testCase.name,
    command: testCase.command,
    args: testCase.args,
    cwd: testCase.cwd,
    timeout_ms: testCase.timeoutMs,
    kinds: testCase.kinds ?? null,
    runtime: testCase.runtime === true,
    always: testCase.always === true,
  };
}

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
function isRepositoryRelative(cwd: string): boolean {
  if (/^(?:[A-Za-z]:|[\\/])/.test(cwd)) return false;
  return !cwd.split(/[\\/]+/).includes("..");
}
