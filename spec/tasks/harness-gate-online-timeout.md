---
task: harness-gate-online-timeout
project: Concordia
kind: 実装
status: review
created: 2026-10-12T00:00:00.000Z
source_session: lictor-c530580e-827f-4ac9-8193-9fbdcf1b52fb
memoria_task_id: null
pr_number: null
actio_task_id: 61aaecb0-80d1-4e9a-84ee-61d159256fee
memory_links: []
---
# Cc 正常時に harness-gate が recovery mode に落ちる不具合を直す (#29)

関連: Actio 61aaecb0 (本タスク) / 878c4db5 (元の不具合報告)

### 原因

`src/harness/supervisor-cli.ts` の `online()` はゲート応答を 2 秒で打ち切っていた。2026-10-12 の監査ログでは、Cc 側のゲート処理時間が p50 2.5 秒・p90 5.5 秒・p99 11.2 秒。同時刻の `/health` は 5〜17 ms で応答しており、Cc は止まっておらず処理が遅いだけだった。submodule など別リポへ cwd を移すとポリシーキャッシュのキーが変わるため、キャッシュが無い状態で打ち切られ、全 Bash が「Cc unavailable」で拒否されていた。

### 変更

- `src/harness/supervisor-online.ts` (新設): ゲートへの問い合わせと待ち方を切り出した。
  - 2 秒待っても応答が無ければ `/health` を 1 秒以内で確認する。
  - 応答があれば稼働中と判断し、ゲート応答を 1 回あたり最大 15 秒まで待つ (p99 を覆い、無制限には待たない)。
  - `/health` も応答しなければ、その場で従来どおりオフライン扱いにする。
  - 結果は `online` / `slow` / `offline` の 3 種類で返す。
- `src/harness/supervisor-cli.ts`: 上記モジュールを使うよう置き換えた。Cc が稼働中なのに上限内に返らず、キャッシュも無い場合だけ `slow` として監査に記録する。拒否理由は「再試行で通りうる遅延」と伝え、Cc 停止とは区別する。許可範囲は復旧範囲のままで広げない。
- `spec/setup/harness-supervisor.md`: 待ち方と `slow` の扱いを追記した。
- `spec/domains/harness-reliability.domain.json`・`cc.acceptance.json`・`.augur/tests.jsonl`: 新しいソースとテストを対応付けた。

### 再利用探索

- 既存の `online()` の HTTP 処理 (1MB 上限、JSON 解釈) はそのまま新モジュールへ移し、`/health` の確認にも共用した。
- ゲート本体 (`/v1/harness/gate`) を速くする案は採らなかった。原因はゲート処理の遅さだが、今回の要件は hook 側で「遅いだけ」と「停止」を区別することなので、範囲を広げないため。
- Augur の契約ラップは入れていない。`ontime-runtime` が Cc 本体の vestigium と metrics を import するため、ラップすると「Node 標準ライブラリだけで動く単体 harness」の前提 (`spec/setup/harness-supervisor.md`) が崩れる。

### 検証

- 実施: `tsc -p tsconfig.harness.json --noEmit` (通過)、`vitest run src/harness/supervisor-online.test.ts src/harness/supervisor-policy.test.ts` (11 件通過)、`augur tests lint` (registry valid)。
- 未実施: 全体テスト・サービス再起動・`harness-runtime` の反映 (委託条件で禁止のため)。
