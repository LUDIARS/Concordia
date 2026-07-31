#!/usr/bin/env node

/**
 * federation-check — 本社 loopback API (GET /v1/federation) を読み、listener の
 * 有効/無効と登録拠点の接続状態を人間向けに整形するだけの運用スクリプト。
 * サービスの起動 / 再起動や設定変更は一切しない (読み取り専用)。
 *
 * 手順: spec/setup/federation.md / 設計: spec/feature/federation-link.md
 *
 *   node tools/federation-check.mjs
 */

// 他の tools/*.mjs と同じく loopback backend の base URL は CONCORDIA_URL で上書きできる
// (CONCORDIA_PORT を既定から変えている環境向け)。
const baseUrl = (process.env.CONCORDIA_URL || "http://127.0.0.1:11111").replace(/\/+$/, "");
const endpoint = `${baseUrl}/v1/federation`;

// federation_sites の時刻列は秒 (db/federation-sites-repo.ts の nowSec)。
// 将来ミリ秒が混ざっても壊れないよう、桁数で単位を判定する。
function formatTimestamp(value) {
  if (value === null || value === undefined) return "-";
  const numeric = typeof value === "number" ? value : Number(value);
  const milliseconds = Number.isFinite(numeric) ? numeric * (numeric < 10_000_000_000 ? 1_000 : 1) : NaN;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? sanitize(value) : date.toLocaleString();
}

/**
 * name は登録時に operator が入れた自由文字列で、API は長さしか縛らない
 * (api/federation.ts の CreateSiteSchema)。ANSI エスケープや CR をそのまま端末へ
 * 流すと表が崩れるだけでなく、行の偽装 (revoked を active に見せる等) もできるので、
 * 制御文字は 1 文字 1 空白に置き換える (列幅計算と長さを揃えるため 1:1)。
 */
function sanitize(value) {
  return String(value ?? "-").replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

function truncate(value, width) {
  const text = sanitize(value);
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function pad(value, width) {
  return truncate(value, width).padEnd(width);
}

/**
 * 列幅を実データに合わせる。site_id は revoke コマンドへそのまま貼るため、
 * 規約上の最大長 (64) までは切らない。name は表が崩れない範囲で上限を置く。
 */
function columnWidth(header, values, max) {
  return Math.min(max, Math.max(header.length, ...values.map((value) => sanitize(value).length)));
}

function printSites(sites) {
  if (sites.length === 0) {
    console.log("No federation sites are registered.");
    return;
  }

  console.log("\nSites");
  const idWidth = columnWidth("SITE ID", sites.map((site) => site.site_id), 64);
  const nameWidth = columnWidth("NAME", sites.map((site) => site.name), 40);
  const header = `${pad("SITE ID", idWidth)}  ${pad("NAME", nameWidth)}  ${pad("STATUS", 9)}  ${pad("CONNECTION", 10)}  ${"PENDING".padStart(7)}  LAST SEEN`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const site of sites) {
    console.log(
      `${pad(site.site_id, idWidth)}  ${pad(site.name, nameWidth)}  ${pad(site.status, 9)}  ${pad(site.connection, 10)}  ${String(site.pending_events ?? 0).padStart(7)}  ${formatTimestamp(site.last_seen_at)}`,
    );
  }
}

async function main() {
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Could not reach Concordia at ${endpoint}: ${detail}`);
    console.error("Start or confirm the loopback Concordia backend, then run this command again.");
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(`Concordia returned HTTP ${response.status} ${response.statusText} for ${endpoint}.`);
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error(`Concordia returned an invalid JSON response from ${endpoint}.`);
    process.exitCode = 1;
    return;
  }

  if (!payload || !Array.isArray(payload.sites)) {
    console.error(`Concordia returned an unexpected federation response from ${endpoint}.`);
    process.exitCode = 1;
    return;
  }

  const online = payload.sites.filter((site) => site.connection === "online").length;
  const pending = payload.sites.reduce((total, site) => total + (Number(site.pending_events) || 0), 0);
  console.log("Concordia federation status");
  console.log(`Listener: ${payload.listener_enabled ? "enabled" : "disabled"}`);
  console.log(`Sites: ${payload.sites.length} registered, ${online} online, ${pending} pending event(s)`);
  printSites(payload.sites);
}

await main();
