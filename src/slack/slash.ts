// Slack slash command (`/concordia <sub>`) のディスパッチ。
// Socket Mode の slash_commands envelope から呼ばれる。v0.2 は読み取り系のみ
// (stat / prs / help)。spawn/end 等の副作用系はフォローアップ。
// 宛先は Discord コマンドと同じ Concordia HTTP API。

import { parseSlashCommand } from "./render.js";
import type { DelegationTemplateLite } from "./delegation-modal.js";

export interface SlashDeps {
  concordiaUrl: string;
}

/** stat の enriched item（必要フィールドだけ緩く拾う）。 */
interface StatItem {
  session_id?: string;
  session?: { status?: string; current_task?: string | null; branch?: string | null } | null;
}

/** `/v1/stat` の items を 1 行ずつの要約に整形（純粋）。 */
export function formatStat(items: StatItem[]): string {
  if (!items.length) return "アクティブな stat はありません。";
  const lines = items.slice(0, 30).map((it) => {
    const sid = (it.session_id ?? "????????").slice(0, 8);
    const st = it.session?.status ?? "?";
    const task = (it.session?.current_task ?? "").trim();
    const branch = (it.session?.branch ?? "").trim();
    const tail = task || branch || "(no task)";
    return `• \`${sid}\` [${st}] ${tail}`;
  });
  return `*セッション現況 (${items.length})*\n${lines.join("\n")}`;
}

export function formatHelp(): string {
  return [
    "*Concordia slash*",
    "• `/concordia stat` — 全セッションの現況",
    "• `/concordia prs` — PR キュー",
    "• `/concordia spawn <claude|codex> [cwd]` — 新規セッション起動",
    "• `/concordia end <session_id 先頭8桁>` — セッション終了",
    "• `/concordia rename <session_id 先頭8桁> <新タイトル>` — やる事を変更",
    "• `/concordia help` — このヘルプ",
    "_(セッションへの入力はスレッド返信、質問回答はボタンで)_",
  ].join("\n");
}

/**
 * `/co-<sub>` 形式の slash command 名から sub を取り出す（純粋）。
 * 例: `/co-stat` → `"stat"`、 `/co-prs` → `"prs"`。`/co-` 始まりでなければ null。
 * これで `/concordia stat` の各サブコマンドを独立 slash (`/co-stat` 等) に分解できる。
 */
export function subFromCoCommand(command: string | undefined): string | null {
  const c = (command ?? "").trim();
  if (!c.startsWith("/co-")) return null;
  return c.slice("/co-".length).toLowerCase() || null;
}

const SPAWN_PROVIDERS = ["claude", "codex"] as const;

/**
 * セッション起動の中核。 slash (`/concordia spawn`) と Slack カスタムステップ
 * (custom function `spawn_session`) の両方から呼ばれる共通ロジック。
 * provider/cwd を構造化入力で受け、 /v1/admin/spawn-session に流して人間向け文を返す。
 */
export async function spawnSession(deps: SlashDeps, providerRaw: string | undefined, cwdRaw?: string): Promise<string> {
  const provider = (providerRaw ?? "claude").trim().toLowerCase();
  if (!SPAWN_PROVIDERS.includes(provider as (typeof SPAWN_PROVIDERS)[number])) {
    return `provider は ${SPAWN_PROVIDERS.join(" / ")} のいずれか。例: \`/concordia spawn claude\``;
  }
  const cwd = (cwdRaw ?? "").trim() || undefined;
  const res = await fetch(`${deps.concordiaUrl}/v1/admin/spawn-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, ...(cwd ? { cwd } : {}) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; pid?: number };
  if (!res.ok) return `spawn 失敗: ${json.error ?? `HTTP ${res.status}`}`;
  return `✅ spawn 起動 (${provider}${cwd ? `, ${cwd}` : ""}) pid=${json.pid ?? "?"}`;
}

/** active な delegation テンプレを取得する（/co-spawn のモーダル用）。失敗時は空配列。 */
export async function listDelegationTemplates(deps: SlashDeps): Promise<DelegationTemplateLite[]> {
  const res = await fetch(`${deps.concordiaUrl}/v1/delegation/templates`);
  if (!res.ok) return [];
  const json = (await res.json().catch(() => ({}))) as { templates?: DelegationTemplateLite[] };
  return json.templates ?? [];
}

/**
 * delegation テンプレを spawn 付きで invoke する（/co-spawn モーダル submit）。
 * /v1/delegation/invoke に {spawn:true} で流し、人間向けの結果文を返す。
 */
export async function invokeDelegation(
  deps: SlashDeps,
  input: { call_name: string; args: Record<string, unknown>; cwd?: string; extra_prompt?: string; triggered_by?: string },
): Promise<string> {
  const res = await fetch(`${deps.concordiaUrl}/v1/delegation/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      call_name: input.call_name,
      args: input.args,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.extra_prompt ? { extra_prompt: input.extra_prompt } : {}),
      triggered_by: input.triggered_by ?? "slack",
      spawn: true,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    detail?: unknown;
    run?: { status?: string };
    spawn_pid?: number;
  };
  if (!res.ok) {
    const detail = json.detail ? ` (${JSON.stringify(json.detail)})` : "";
    return `委託起動 失敗: ${json.error ?? `HTTP ${res.status}`}${detail}`;
  }
  if (json.run?.status === "spawn_failed") return `委託テンプレ \`${input.call_name}\` の spawn に失敗しました。`;
  return `✅ 委託起動: \`${input.call_name}\` pid=${json.spawn_pid ?? "?"}`;
}

/** `/concordia spawn <provider> [cwd]` の引数文字列を構造化して spawnSession に渡す。 */
async function doSpawn(deps: SlashDeps, args: string): Promise<string> {
  const parts = args.split(/\s+/).filter(Boolean);
  return spawnSession(deps, parts[0], parts.slice(1).join(" "));
}

/** `/concordia end <sid8>` — session_id 先頭一致で 1 件に解決して DELETE。 */
async function doEnd(deps: SlashDeps, args: string): Promise<string> {
  const prefix = args.trim().split(/\s+/)[0] ?? "";
  if (prefix.length < 4) return "session_id の先頭 4 桁以上を指定してください。例: `/concordia end ab12cd34`";
  const listRes = await fetch(`${deps.concordiaUrl}/v1/sessions?status=active`);
  if (!listRes.ok) return `セッション一覧取得失敗 (${listRes.status})`;
  const listJson = (await listRes.json()) as { sessions?: Array<{ id?: string }> };
  const matches = (listJson.sessions ?? []).filter((s) => typeof s.id === "string" && s.id.startsWith(prefix));
  if (matches.length === 0) return `\`${prefix}\` に一致する active セッションがありません。`;
  if (matches.length > 1) return `\`${prefix}\` が複数一致 (${matches.length})。より長い prefix を指定してください。`;
  const id = matches[0].id!;
  const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return `end 失敗 (${res.status}) session=${id.slice(0, 8)}`;
  return `✅ セッション終了: \`${id.slice(0, 8)}\``;
}

/** `/concordia rename <sid8> <text>` — セッションのタイトル(やる事)を変更。Lictor 非注入の /title。 */
async function doRename(deps: SlashDeps, args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const prefix = parts[0] ?? "";
  const text = parts.slice(1).join(" ").trim();
  if (prefix.length < 4 || !text) return "使い方: `/concordia rename <session_id 先頭8桁> <新タイトル>`";
  const listRes = await fetch(`${deps.concordiaUrl}/v1/sessions?status=active`);
  if (!listRes.ok) return `セッション一覧取得失敗 (${listRes.status})`;
  const listJson = (await listRes.json()) as { sessions?: Array<{ id?: string }> };
  const matches = (listJson.sessions ?? []).filter((s) => typeof s.id === "string" && s.id.startsWith(prefix));
  if (matches.length === 0) return `\`${prefix}\` に一致する active セッションがありません。`;
  if (matches.length > 1) return `\`${prefix}\` が複数一致。より長い prefix を。`;
  const id = matches[0].id!;
  const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(id)}/title`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 200) }),
  });
  if (!res.ok) return `rename 失敗 (${res.status})`;
  return `✅ \`${id.slice(0, 8)}\` のタイトルを「${text}」に変更`;
}

/** slash command 本文を処理して返信テキストを返す。失敗は人間向けメッセージに丸める。 */
export async function runSlackSlash(deps: SlashDeps, text: string): Promise<string> {
  const { sub, args } = parseSlashCommand(text);
  try {
    if (sub === "stat") {
      const res = await fetch(`${deps.concordiaUrl}/v1/stat`);
      if (!res.ok) return `stat 取得失敗 (${res.status})`;
      const json = (await res.json()) as { items?: StatItem[] };
      return formatStat(json.items ?? []);
    }
    if (sub === "prs" || sub === "pr") {
      const res = await fetch(`${deps.concordiaUrl}/v1/prs/digest`);
      if (!res.ok) return `PR キュー取得失敗 (${res.status})`;
      const json = (await res.json()) as { markdown?: string };
      const md = (json.markdown ?? "").trim();
      return md || "PR はありません。";
    }
    if (sub === "spawn") return await doSpawn(deps, args);
    if (sub === "end") return await doEnd(deps, args);
    if (sub === "rename") return await doRename(deps, args);
    if (sub === "help" || !sub) return formatHelp();
    return `未知のサブコマンド: \`${sub}\`${args ? ` ${args}` : ""}\n${formatHelp()}`;
  } catch (e) {
    return `エラー: ${(e as Error).message}`;
  }
}
