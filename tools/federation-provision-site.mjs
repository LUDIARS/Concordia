#!/usr/bin/env node

/**
 * federation-provision-site — 本社で拠点を登録して token を発行し、Excubitor の依頼
 * (`concordia-federation-site`) で拠点の Concordia に連合設定を入れる運用スクリプト。
 *
 * 拠点 Concordia の PUT /v1/federation/site は loopback 限定なので、拠点の外から設定を入れる経路は
 * 相互登録済みの Excubitor 依頼だけ (2026-10-06 neco 判断)。
 *
 * - token は標準出力・ログ・ファイルに出さない (このプロセスのメモリだけ)。
 * - 依頼の POST は再送しない (202 は受付であって完了ではない。状態を GET で待つ)。
 * - 既に同じ site_id がある場合は止める (旧 ID は再利用できない。revoke して新しい ID で登録し直す)。
 *
 * 手順: spec/setup/federation.md / 設計: spec/feature/federation-link.md
 *
 *   node tools/federation-provision-site.mjs --peer <Excubitor peer id> --site-id melpot --name MELPOT
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSiteOperation,
  excubitorPortFromCatalog,
  hqUrlFromListener,
  isFinalStatus,
  parseProvisionArgs,
  siteConnection,
  validateHqUrl,
} from "./federation-provision-site-core.mjs";

const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT_MS = 180_000;

const concordiaUrl = (process.env.CONCORDIA_URL || "http://127.0.0.1:11111").replace(/\/+$/, "");

function excubitorUrl() {
  if (process.env.EXCUBITOR_URL) return process.env.EXCUBITOR_URL.replace(/\/+$/, "");
  const arsRoot = process.env.ARS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const catalogPath = resolve(arsRoot, "Excubitor", "excubitor.catalog.yaml");
  const port = excubitorPortFromCatalog(readFileSync(catalogPath, "utf8"));
  if (!port) throw new Error(`Excubitor の port を ${catalogPath} から読めません (EXCUBITOR_URL で指定してください)`);
  return `http://127.0.0.1:${port}`;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json; charset=utf-8" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, ok: res.ok, json };
}

/** エラー応答を token を含まない短い文にする。 */
function describe(res) {
  const error = typeof res.json?.error === "string" ? res.json.error : "";
  return `HTTP ${res.status}${error ? ` ${error}` : ""}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const parsed = parseProvisionArgs(process.argv.slice(2));
  if (parsed.error) { console.error(parsed.error); process.exit(2); }
  const args = parsed.value;
  const ex = excubitorUrl();

  // 1. 本社 URL を決める (指定が無ければ本社 listener の bind 先から組む)。
  let hqUrl;
  if (args.hqUrl) {
    const v = validateHqUrl(args.hqUrl);
    if (v.error) throw new Error(v.error);
    hqUrl = v.value;
  } else {
    const listener = await call("GET", `${concordiaUrl}/v1/federation/listener`);
    if (!listener.ok) throw new Error(`本社 listener の状態を読めません: ${describe(listener)}`);
    const v = hqUrlFromListener(listener.json);
    if (v.error) throw new Error(v.error);
    hqUrl = v.value;
  }
  console.log(`本社 URL: ${hqUrl}`);
  console.log(`拠点: ${args.siteId}${args.name ? ` (${args.name})` : ""} / Excubitor peer: ${args.peer}`);
  if (args.dryRun) { console.log("--dry-run: 登録と依頼はしません"); return; }

  // 2. 本社で拠点を登録して token を受け取る (平文はこの応答だけ)。
  const created = await call("POST", `${concordiaUrl}/v1/federation/sites`, { site_id: args.siteId, ...(args.name ? { name: args.name } : {}) });
  if (created.status === 409) throw new Error(`site_id ${args.siteId} は登録済みです。旧 ID は再利用できないので、revoke して新しい site_id で登録し直してください`);
  if (!created.ok || typeof created.json?.token !== "string") throw new Error(`拠点の登録に失敗しました: ${describe(created)}`);
  console.log(`本社に拠点 ${args.siteId} を登録しました`);

  // 3. Excubitor の依頼で拠点 Concordia に設定を入れる (POST は 1 回だけ)。
  const requested = await call("POST", `${ex}/api/v1/peers/${encodeURIComponent(args.peer)}/operations`,
    buildSiteOperation({ hqUrl, siteId: args.siteId, token: created.json.token }));
  if (!requested.ok || !requested.json?.operation?.id) {
    throw new Error(`拠点への依頼に失敗しました: ${describe(requested)}。同じ site_id では入れ直せないので、revoke して新しい site_id で登録し直してください`);
  }
  const opId = requested.json.operation.id;
  console.log(`依頼を受け付けました (operation ${opId})。完了を待ちます`);

  const deadline = Date.now() + POLL_LIMIT_MS;
  let op = requested.json.operation;
  while (!isFinalStatus(op.status) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const got = await call("GET", `${ex}/api/v1/peers/${encodeURIComponent(args.peer)}/operations/${encodeURIComponent(opId)}`);
    if (got.ok && got.json?.operation) op = got.json.operation;
  }
  for (const step of op.steps ?? []) console.log(`  ${step.ok ? "ok " : "NG "} ${step.step}: ${step.detail}`);
  if (!isFinalStatus(op.status)) throw new Error(`依頼の完了を確認できません (状態 ${op.status})。再送せず、Excubitor の依頼履歴で ${opId} を確認してください`);
  if (op.status !== "succeeded") throw new Error(`拠点への設定に失敗しました: ${op.error ?? "unknown"}`);

  // 4. 本社から見た接続状態を表示する (接続は拠点の再接続間隔しだいで数秒〜1 分遅れる)。
  const listing = await call("GET", `${concordiaUrl}/v1/federation`);
  const conn = listing.ok ? siteConnection(listing.json, args.siteId) : null;
  console.log(`本社から見た拠点 ${args.siteId}: ${conn ? `${conn.status} / ${conn.connection}` : "不明"}`);
}

main().catch((error) => {
  console.error(`federation-provision-site: ${error.message}`);
  process.exit(1);
});
