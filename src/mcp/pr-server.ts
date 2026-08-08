/**
 * concordia-pr — Revisor local PR の提出・状態確認・マージを MCP tool として露出する。
 *
 * 「マージ権限のトークンが多すぎる」対策 (2026-08-08 neco 指示):
 * MCP クライアント (セッション) はトークンを一切持たない。 Revisor workflow token は
 * Cc 内部 (DB 正本、 secret-box) で解決され、 人間側の認可は Cc HTTP endpoint の
 * 社員名簿 capability 判定 (`merge_pr`) だけになる — 認可は抜かず、 配布だけを消す。
 *
 * 使い方 (mcpServers):
 *   {
 *     "concordia-pr": {
 *       "command": "node",
 *       "args": ["E:/Document/Ars/Concordia/dist/mcp/pr-server.js"],
 *       "env": { "CONCORDIA_BASE_URL": "http://127.0.0.1:11111" }
 *     }
 *   }
 *
 * tool 一覧:
 *   - pr_submit  — repo_path + branch の direct 提出 (session 登録不要)
 *   - pr_status  — Revisor local PR 一覧 (審査状態の確認)
 *   - pr_merge   — local PR のマージ (roster `merge_pr` 判定は Cc 側で行う)
 *
 * Concordia HTTP loopback を直接叩く。 DB は触らない (core-server.ts と同じ責任分界)。
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callConcordia, toToolResult } from "./core-server.js";

/**
 * Build the MCP server with tools registered. Exported so tests can
 * instantiate it without going through stdio.
 */
export function buildPrServer(): McpServer {
  const server = new McpServer(
    { name: "concordia-pr", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "pr_submit",
    {
      description:
        "作業ブランチを Revisor の local PR として提出する (レビュー発火)。 Cc の"
        + " session/task 登録は不要 — repo_path と branch だけで既存の提出判定に載る。"
        + " 既に open な同一ブランチの PR が failed/action_required なら自動で再審査 (retry) になる。"
        + " 提出しなかった場合も理由 (reason) が返る。",
      inputSchema: {
        repo_path: z.string().describe("リポジトリ (worktree 可) の絶対パス"),
        branch: z.string().optional().describe("提出するブランチ。 省略時は checkout ブランチ"),
        session_id: z.string().optional().describe("審査結果 inject を受けたい Cc session id (任意)"),
      },
    },
    async ({ repo_path, branch, session_id }) =>
      toToolResult(await callConcordia("POST", "/v1/prs/local/direct", {
        repo_path,
        ...(branch ? { branch } : {}),
        ...(session_id ? { session_id } : {}),
      })),
  );

  server.registerTool(
    "pr_status",
    {
      description:
        "Revisor の local PR 一覧と審査状態 (queued/running/test_ok/failed/action_required)"
        + " を返す。 repository でフィルタできる。",
      inputSchema: {
        repository: z.string().optional().describe("owner/repo で絞り込み (部分一致・大文字小文字無視)"),
      },
    },
    async ({ repository }) => {
      const result = await callConcordia("GET", "/v1/prs/revisor");
      if (!result.ok || !repository) return toToolResult(result);
      const body = result.body as { pull_requests?: Array<{ repository?: string }> };
      if (!Array.isArray(body?.pull_requests)) return toToolResult(result);
      const needle = repository.toLowerCase();
      return toToolResult({
        ...result,
        body: {
          ...body,
          pull_requests: body.pull_requests.filter((pr) =>
            (pr.repository ?? "").toLowerCase().includes(needle)),
        },
      });
    },
  );

  server.registerTool(
    "pr_merge",
    {
      description:
        "Revisor local PR をマージする。 認可は Cc 側で行う: session の直近の人間指示者が"
        + " 社員名簿 capability `merge_pr` (管理職以上) を持つときだけ実行される。"
        + " Test OK (mergeable) の PR にのみ使うこと。",
      inputSchema: {
        local_pr_id: z.string().describe("Revisor local PR の id"),
        session_id: z.string().describe("マージ指示を受けた Cc session id (認可の解決元)"),
      },
    },
    async ({ local_pr_id, session_id }) =>
      toToolResult(await callConcordia(
        "POST",
        `/v1/prs/local/${encodeURIComponent(local_pr_id)}/merge`,
        { session_id },
      )),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildPrServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[concordia-pr-mcp] connected via stdio\n");
}

const isEntrypoint = (() => {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  return import.meta.url.endsWith(norm) || import.meta.url === `file:///${norm}`;
})();

if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`[concordia-pr-mcp] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
