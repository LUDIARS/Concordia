/**
 * 適用済み migration の凍結台帳。
 *
 * `runMigrations` は schema_migrations の checksum と実装を突き合わせ、 食い違えば
 * 起動を止める。 これは正しい防御だが、 発火するのは「次に誰かが再起動したとき」で、
 * 編集した本人はその場では何も起きない — dist 常駐サービスなので時限爆弾になる
 * (2026-08-04 と 2026-08-08 に実際に Concordia が起動不能になった)。
 *
 * ここはその爆弾を「編集した時点」で鳴らすための凍結値。 テスト
 * (`migration-ledger.test.ts`) が実装から再計算した値と突き合わせるので、 適用済み
 * migration に手を入れた変更はレビューを通らない。
 *
 * 新しいテーブル / 列を足すときは、 既存エントリを触らず末尾に番号付き migration と
 * その凍結エントリを 1 件追加する。 既存エントリの値を書き換えて緑にするのは、
 * 本番 DB の台帳を手で直す作業とセットでしか正当化されない。
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface FrozenMigration {
  version: number;
  name: string;
  /** `migrationChecksum` が返す値。 本番 schema_migrations に保存されているものと同じ。 */
  checksum: string;
}

/**
 * 全 migration を適用した後のスキーマ指紋。
 *
 * checksum は version / name / source しか見ないため、 source 文字列を据え置いたまま
 * `up()` の SQL だけ書き換える編集を素通ししてしまう。 その場合起動は通るが、 DB の
 * 中身が「いつ作られたか」で変わり、 環境ごとにスキーマが割れる。
 *
 * 指紋は sqlite_master の実体から取る。 関数本文のハッシュにしないのは、 トランスパイラ
 * (tsx / esbuild / tsc) ごとに出力が変わって偽陽性で落ちるため — 実測で tsx と vitest が
 * 別の値を出した。 スキーマそのものならツールチェインに依存しない。
 */
export const SCHEMA_FINGERPRINT = "fd80d9d5e77145118c72a50dbd3f8f005ddb06e67610885a3a546a89843cd764";

/**
 * 適用済み DB のスキーマ指紋。 sqlite_master を種別・名前で整列し、 空白を潰してから
 * 取る (SQLite は CREATE 文を原文のまま保存するため、 インデントの差で値が動かないように)。
 * 内部テーブル (sqlite_ 接頭辞) は SQLite の実装都合なので除く。
 */
export function schemaFingerprint(db: Database.Database): string {
  const rows = db.prepare(
    `SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; sql: string }>;
  const canonical = rows
    .map((row) => `${row.type}\t${row.name}\t${row.sql.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const FROZEN_MIGRATIONS: readonly FrozenMigration[] = [
  {
    version: 41,
    name: "baseline-v41",
    checksum: "3c3b993588446d9884b382760255623d60b2e72ca8fefcef447e6ec29c673ccc",
  },
  {
    version: 42,
    name: "test-forum-pr-head-surfaces",
    checksum: "2507b4a1407ae5881227e844b84e976f604857699596a858357ce128544a05cf",
  },
  {
    version: 43,
    name: "federation-link-p1",
    checksum: "2cb9d79eb1b2aa7d2bb17c44c381233c1df5e011463c93726905ee90c393b16d",
  },
  {
    version: 44,
    name: "staff-roster-permissions",
    checksum: "bf15a44c1bed119073cc80ca673e204c13c4411fee172efb6f4165c9590c53e0",
  },
  {
    version: 45,
    name: "federation-site-departments-p2",
    checksum: "6b67afb544cdbb347121c33e0b6ea88b682f176663eb47ce7f54c52f01e0ec7f",
  },
  {
    version: 46,
    name: "federation-site-villa-pc",
    checksum: "905f3aa76750db50516ec34d2c79b2ce2fffad9f4312a1b47372a2d58d1504af",
  },
  {
    version: 47,
    name: "revisor-config",
    checksum: "e7579e2bbffea8901424044d3cfeeb6ba48e87e029581593c79bae9059e0eede",
  },
  {
    version: 48,
    name: "test-forum-content-hash-qa-run",
    checksum: "0ae0ec95c4fb5f7d485f5f209c8ce888dc9c61f5db9532cb953e6d92f2506e56",
  },
  {
    version: 49,
    name: "test-surface-controls",
    checksum: "af13c1ebf8e19bd3b51a7f6b4d8c04be5551da519a55ccdafe4641d02059e5c7",
  },
  {
    version: 50,
    name: "test-surface-spawn-target",
    checksum: "3b121fa0cf1977ddfc54611fe6297b32d8a62c1a710ae496c33b9b21d2f98ca2",
  },
  {
    version: 51,
    name: "test-surface-check-status",
    checksum: "d6dc149109d529008bb9fb111f1a1f2966a76ce395c3c152e0cffa669fad498f",
  },
  {
    version: 52,
    name: "inquiry-protocol",
    checksum: "3386bd9e0493ae8f1971ef782866b3035126b930f20f08c4723d4d106d13b9f5",
  },
  {
    version: 53,
    name: "session-message-layer-d1",
    checksum: "a85b862b50a48457e354dc17a22b89c2ac3be8dce0026b9366653ffaef395012",
  },
  {
    version: 54,
    name: "taskflow-runtime-state",
    checksum: "16315fdcf9cdc361483b5363cf06bdffd4624175383c18223098c583932e0f49",
  },
  {
    version: 55,
    name: "discord-pending-question-channel",
    checksum: "3e4bae16fb0d14d589351ad8c77667a96fca0701cfb8e5bb844042c79e6d59f6",
  },
  {
    version: 56,
    name: "director-script-flow",
    checksum: "9cb25ccfbcf6abf9834ff31ffe06d9b4c807dab0c15bab2d2fe122f8e8f5ee32",
  },
  {
    version: 57,
    name: "director-decision-audit-order",
    checksum: "100b59cd0f8b72d3c75dc1085ae60aa5c3c33f56d17820a332cf4704c80ca6b9",
  },
  {
    version: 58,
    name: "web-push-subscriptions",
    checksum: "a633983e652e3249ecf753a5c9bc6595ee15a78d698ba88a1d992c1d11cace3d",
  },
  {
    version: 59,
    name: "taskflow-inject-state-in-db",
    checksum: "5bbf12f6841e667623311c98193f91aaad2e4dc9abbdc610186c756b4354eafc",
  },
  {
    version: 60,
    name: "taskflow-runtime-state-constraints",
    checksum: "87a04bef30fe20a4a5e4ad796f1e6ca5517f1aa0a33e4cd34230e217d9da83f2",
  },
  {
    version: 61,
    name: "taskflow-task-state-slug",
    checksum: "638b74baa99ba52d4e37f7b06a580da92c302994f2f8e2cf1531d0d1b547463b",
  },
  {
    version: 62,
    name: "delegation-staged-injection",
    checksum: "adc375079f4653c155956df3ef62eb1ad35f6703c7c5f1f29f1edf933ab324ac",
  },
  {
    version: 63,
    name: "director-plan-version",
    checksum: "9370690504779925e8d7dc7b5d15314af1ae97a15d72c2a3863d16d154f1006c",
  },
  {
    version: 64,
    name: "director-case-session",
    checksum: "af60948ddba191ec778fc06d6a05f17238698fe5bba8262fece4c5576da51f5d",
  },
  {
    version: 65,
    name: "teams-core",
    checksum: "4f0ffac855008ea2d46cd666c9d43ef37c130e76fa164d847fdb096526ef320f",
  },
  {
    version: 66,
    name: "harness-rules-team-scope",
    checksum: "44d89501efe0df21d32fc4bf2b92f1d291dfcaf1bde38762f04edcd08140972d",
  },
  {
    version: 67,
    name: "team-audit-posts",
    checksum: "4634cf6a8af3ee524f659c0f6bf5b58610ea87a474f3a8c238ea2c9f14a8ffc0",
  },
  {
    version: 68,
    name: "director-ask-human-bundle",
    checksum: "89540fbccddd5cb5e45ca7cec695d68762f0af6ba045b73f9a6565e01992dde0",
  },
  {
    version: 69,
    name: "director-case-stall-ticks",
    checksum: "9a110f7ed1174b53ec8858e180773fa5eb4e4cddc8f39ca0f3a46651d34d2437",
  },
  {
    version: 70,
    name: "escalation-mode",
    checksum: "52598185c13158751b6aefc6a51bf60abf1f10df2e73cb1bf85f0d73a4cf242d",
  },
  {
    version: 71,
    name: "project-code-registry",
    checksum: "b3b64e6a11ffa6aeb315c4f84cd9eccace9a6d5e8f35df5a83083c79592259b9",
  },
  {
    version: 72,
    name: "cc-task-fallback",
    checksum: "ea5af6ab41ddd08f0b46cc293b746e65353435ff6c81e75b29b430dfc115cc95",
  },
  {
    version: 73,
    name: "delegation-sdk-safety-and-legacy-delete",
    checksum: "fc0a07e1021a33863cc586afea93751eed0dcea168c38d52e486ab34f21ca80a",
  },
  {
    version: 74,
    name: "team-suspend",
    checksum: "9a1183e296f90179f519b7fcc8538105afde5dcd6aaffb0b33738e5e0efedab3",
  },
  {
    version: 75,
    name: "delegation-template-overrides",
    checksum: "60f1302b132ae3aa504bc2a8374f583ac6710e407e2ff4fcfc790b29a1f5f14b",
  },
  {
    version: 76,
    name: "federation-site-platform",
    checksum: "c9d757af96c92a33957bc5236e6b867a56aabd895ac9a76ab2c4db7fdc48b070",
  },
  {
    version: 77,
    name: "subsidiary-taskflow-scope",
    checksum: "c5f61c3a8ed02793f77829acc7b7f15d9f5ecc8579b50c4499786772e0243021",
  },
  {
    version: 78,
    name: "subsidiary-teams",
    checksum: "51c7ec33ab9533857e9db0368ae3a6ac3182e92c34a1689728877d7e87ef8983",
  },
  {
    version: 79,
    name: "curiosity-walks",
    checksum: "a6b40404d6f0ee20711eb90fef19a9b628e1d6a3b8e39835c12f1d0b99741890",
  },
  {
    version: 80,
    name: "session-events-ts-index",
    checksum: "ce298cf91776e7dc771aa6ff27edb2a407d1b440146876840e0e4e694de0740c",
  },
  {
    version: 81,
    name: "subsidiary-projects",
    checksum: "9097d5555592d20a53f4abb2a6ef7c02fd3a79127e2893e8955f289017b54ddf",
  },
  {
    version: 82,
    name: "delegation-template-review-only",
    checksum: "787a1148cbdc132e076927eba1d5957c0b866423bfb557336c423ca7f36c14de",
  },
  {
    version: 83,
    name: "parttimer-chore-manual",
    checksum: "438b1fa67dc7cae048f1e9c4ca4522641e41558ea49651b6d51ebcec91b3ceb4",
  },
  {
    version: 84,
    name: "delegation-run-category",
    checksum: "53e1be57d9146b80e17a5cf255835490c1574cdf56cc555a8cc0a46f3de186a4",
  },
  {
    version: 85,
    name: "inbox-notice-state",
    checksum: "29d424e4f3752194b167949c06fd72b3529fc93d2d9a83adcdd8400a294f8bd1",
  },
];
