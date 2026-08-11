---
task: main-push-allowlist-webui-setting
project: Concordia
kind: 実装
created: 2026-08-12
memory_links:
  - spec/plan/harness-melpot-allowlist-design.md
---
# main push 許可リストの WebUI 編集

## 目的

`harness.main_push_allowlist` は設定レジストリの `string-list` として登録され、汎用設定画面と
`PUT /v1/admin/settings` から編集できる。保存値は gate リクエストごとに読み直されるため、
再起動なしで反映される。残る作業は、設定変更者・変更時刻を audit / ログから追えるようにすること。

## 完了条件

- [x] 許可リストを WebUI (設定画面) から読み書きできる。 値は配列 (リポのディレクトリ名 or 絶対パス)。
- [x] 汎用設定 API の検証済み `SettingsDbWriter` 経由で `harness.main_push_allowlist` を保存する
      (専用 setter / API は増やさない)。
- [x] 空配列の保存が「例外なし」の明示指定として保持されること (env / 既定へフォールバックしない)
      を UI 上でも区別できる。 未設定 (= env / 既定にフォールバック) と空配列は別状態。
- [x] 保存後、 再起動なしで gate 判定に反映されること (設定は gate ハンドラで都度解決済み)。
- [ ] 設定変更が audit / ログから追えること。

## 備考

- 解決順は 設定 → env `HARNESS_MAIN_PUSH_ALLOWLIST` → 既定 `KuzuSurvivors,MakaiNui`
  (`src/admin/runtime-settings.ts` の `getHarnessMainPushAllowlist`)。
- env のカンマ / 改行区切りは `listEnvFormat: "comma-or-newline"` で設定レジストリにも明示し、
  gate と設定画面で実効値が食い違わないようにする。

## スコープ (編集可ディレクトリ)

- `src/api/` (汎用設定 API の変更 audit)
- `src/config/settings/` (必要なら audit hook の接続)
