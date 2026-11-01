/** @implements SPEC-CONSULT-PROJECTLESS — bounded dispatch to the same fixed fetcher Claude uses. */
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { executeNode } from "./command-tools/process.mjs";

export const FETCH_TOOL = "mcp__consult_fetch_link__fetch_link";
const errorResult = text => ({ isError: true, content: [{ type: "text", text }] });

/** No model-provided executable, cwd, flags, env, cache directory or credentials. */
export function validateFetchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 1 || typeof input.url !== "string" || input.url.length > 2048) return false;
  try {
    const url = new URL(input.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && !/[\r\n\u0000]/.test(input.url);
  } catch { return false; }
}

/** Startup configuration is supplied by Cc, never by the tool caller. Shared classifier keeps Claude parity. */
export async function loadFetchPolicy(script) {
  if (typeof script !== "string" || !isAbsolute(script)
    || !script.replace(/\\/g, "/").endsWith("/_source/tools/fetch-link/fetch-link.mjs")) {
    throw new Error("Consult fetcher configuration is missing or invalid");
  }
  const lib = new URL("./lib/", pathToFileURL(script));
  const { classifyLink } = await import(new URL("classify-url.mjs", lib).href);
  const { loadTrustedSites } = await import(new URL("trusted-sites.mjs", lib).href);
  return url => classifyLink(url, loadTrustedSites());
}

export async function checkFetchGate(env, url, fetchImpl = fetch) {
  if (!env.CONCORDIA_SESSION_ID || !env.CONCORDIA_URL) return false;
  try {
    const sessionResponse = await fetchImpl(`${env.CONCORDIA_URL.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(env.CONCORDIA_SESSION_ID)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!sessionResponse.ok || (await sessionResponse.json()).session?.status !== "active") return false;
    const response = await fetchImpl(`${env.CONCORDIA_URL.replace(/\/+$/, "")}/v1/harness/gate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: env.CONCORDIA_SESSION_ID, hook: "consult-fetch-mcp",
        action: { tool: FETCH_TOOL, command: url } }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const verdict = await response.json();
    return !verdict.blocked && (verdict.decision === "allow" || verdict.decision === "warn");
  } catch { return false; }
}

/** One fetch per bridge; time/output limits and process-tree cleanup belong to existing executeNode. */
export function createFetchDispatcher({ script, classify, gate, execute = executeNode }) {
  let busy = false;
  return async (input, { signal } = {}) => {
    if (!validateFetchInput(input)) return errorResult("公開リンクのURLを1つだけ指定してください。");
    if (busy) return errorResult("取得中です。前の取得が終わってから試してください。");
    busy = true;
    try {
      const link = classify(input.url);
      if (link.kind === "unsupported") return errorResult(link.reason);
      if (!await gate(input.url)) return errorResult("相談の取得許可を確認できませんでした。取得は実行していません。");
      if (signal?.aborted) return errorResult("取得を中止しました。");
      const cancel = () => process.emit("SIGTERM");
      signal?.addEventListener("abort", cancel, { once: true });
      let result;
      try { result = await execute({ cwd: dirname(script), argv: [script, input.url], timeoutMs: 120_000, outputLimit: 1_048_576 }); }
      finally { signal?.removeEventListener("abort", cancel); }
      if (result.reason) return errorResult(`取得を終了しました (${result.reason})。全文を取得できたとは扱わないでください。`);
      if (!result.stdout.trim()) return errorResult("取得結果が返りませんでした。");
      return { ...(result.status === "success" ? {} : { isError: true }), content: [{ type: "text", text: result.stdout }] };
    } catch {
      // Do not expose host paths, credentials or raw child stderr to the conversation.
      return errorResult("公開リンクの取得処理に失敗しました。");
    } finally { busy = false; }
  };
}
