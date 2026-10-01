/**
 * CDGD マネジメント層の MCP server (stdio)。 dots の接続済み PC で動かす想定。
 *
 * 起動: `node dist/mcp/management-server.js`
 * env:
 *   CONCORDIA_BASE_URL         (既定 http://127.0.0.1:11111)
 *   CONCORDIA_MANAGEMENT_TOKEN 任務のトークン (Cc 管理画面で発行)
 *
 * 公開するのは CC-MGMT-03 の 6 操作だけ。 サービスへの書込み・受入・承認の tool は持たない
 * (CC-MGMT-INV-01)。 spec/feature/cdgd-management.md。
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { concordiaBaseUrl } from "../config/service-urls.js";

const FETCH_TIMEOUT_MS = 15_000;

export interface ManagementCallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export type ManagementCaller = (method: "GET" | "POST", path: string, body?: unknown) => Promise<ManagementCallResult>;

export function createManagementCaller(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ManagementCaller {
  return async (method, path, body) => {
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (error) {
      // 送信後に応答を失った場合を含む。 依頼は同じ request_key で再送・照会する。
      return { ok: false, status: 0, body: { error: "result_unknown", detail: (error as Error).message } };
    }
  };
}

function toToolResult(result: ManagementCallResult) {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `concordia management call failed (${result.status}): ${JSON.stringify(result.body)}` }],
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body, null, 2) }] };
}

export function buildManagementServer(call: ManagementCaller): McpServer {
  const server = new McpServer(
    { name: "concordia-management", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool("read_management_context", {
    description: "任務・未完了の依頼・直近の判断・処理済み位置・未処理の変更数・対象プロジェクトの稼働セッション・出所ごとの最終受信を返す。再開時は最初にこれを読む。",
    inputSchema: {},
  }, async () => toToolResult(await call("GET", "/v1/management/context")));

  server.registerTool("read_management_changes", {
    description: "処理済み位置 (または after) より後の変更を seq 昇順で返す。sources は出所ごとの最終受信時刻で、受信が無い出所は「変更なし」ではなく未接続の可能性がある。",
    inputSchema: {
      after: z.number().int().min(0).optional().describe("この seq より後を返す。省略時は処理済み位置"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, async ({ after, limit }) => {
    const params = new URLSearchParams();
    if (after !== undefined) params.set("after", String(after));
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    return toToolResult(await call("GET", `/v1/management/changes${qs ? `?${qs}` : ""}`));
  });

  server.registerTool("record_management_decision", {
    description: "依頼しない判断 (wait/skip/investigate/attach) と理由を記録する。処理済み位置は判断か依頼の根拠に含めた変更までしか進められない。decision_key で冪等。",
    inputSchema: {
      decision_key: z.string().min(1).max(200),
      verdict: z.enum(["wait", "skip", "investigate", "attach"]),
      evidence_seqs: z.array(z.number().int().positive()).min(1).max(200),
      rationale: z.string().min(1).max(4000),
    },
  }, async (input) => toToolResult(await call("POST", "/v1/management/decisions", input)));

  server.registerTool("submit_management_request", {
    description: "Cc へ作業を依頼する。Cc が既存担当との照合・上限・人間判断の要否を判定し、受付状態を返す。結果が不明なら同じ request_key で再送するか get_management_request で照会し、別のキーで出し直さない。根拠が AI 由来の変更だけの依頼は拒否される。",
    inputSchema: {
      request_key: z.string().min(1).max(200),
      kind: z.string().min(2).max(41).describe("任務で許可された依頼種別"),
      project_code: z.string().min(1).max(64),
      target_key: z.string().min(1).max(200).describe("対象の決定的なキー (例: cf:variant/<id>)"),
      purpose: z.string().min(1).max(4000),
      completion_criteria: z.string().min(1).max(4000),
      evidence_seqs: z.array(z.number().int().positive()).min(1).max(200),
      rationale: z.string().min(1).max(4000),
    },
  }, async (input) => toToolResult(await call("POST", "/v1/management/requests", input)));

  server.registerTool("get_management_request", {
    description: "request_key または依頼 ID から受付・実行・成果・受入の状態を返す。",
    inputSchema: { key: z.string().min(1).max(200) },
  }, async ({ key }) => toToolResult(await call("GET", `/v1/management/requests/${encodeURIComponent(key)}`)));

  server.registerTool("acknowledge_management_changes", {
    description: "seq までの変更を処理済みにする。範囲内に判断も依頼も記録されていない変更があれば拒否される。",
    inputSchema: { seq: z.number().int().positive() },
  }, async ({ seq }) => toToolResult(await call("POST", "/v1/management/acknowledge", { seq })));

  return server;
}

async function main(): Promise<void> {
  const token = process.env.CONCORDIA_MANAGEMENT_TOKEN?.trim();
  if (!token) throw new Error("CONCORDIA_MANAGEMENT_TOKEN is required");
  const server = buildManagementServer(createManagementCaller(concordiaBaseUrl(), token));
  await server.connect(new StdioServerTransport());
  process.stderr.write("[concordia-management-mcp] connected via stdio\n");
}

const isEntrypoint = (() => {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  return import.meta.url.endsWith(norm) || import.meta.url === `file:///${norm}`;
})();

if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`[concordia-management-mcp] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
