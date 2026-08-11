---
task: harness-melpot-main-push-allowlist
project: Concordia
kind: 実装
created: 2026-08-12
memory_links:
  - spec/plan/harness-melpot-allowlist-design.md
---
# ハーネス main push 許可リスト (MELPOT 例外)

設計正本: `spec/plan/harness-melpot-allowlist-design.md`。

## 目的

MELPOT (KuzuSurvivors / MakaiNui) は push を閉じておらず全リポ private なため、
main へ直接 push してよい。 ハーネスの `no-main-push` をリポ単位の許可リストで例外化し、
それ以外のリポでは従来どおり deny を維持する。

## 完了条件

- [x] 許可判定を `src/harness/main-push-allowlist.ts` に集約。 判定対象は `action.cwd` と
      コマンド中の `git -C <path>` の両方 (例: `git -C C:/repos/KuzuSurvivors push origin main`)。
      エントリはディレクトリ名 (パス区切り単位のセグメント一致) / 絶対パス (完全一致 + 配下) の両対応で、
      Windows パス (大小文字・`\`) を正規化して比較する。 複合 shell コマンドは対象との対応を
      安全に確定できないため fail-closed とし、 `.` / `..` を解決してから照合する。 decoy `-C`、
      inline alias、追加 Git global option による対象差し替えでの回避を許さない。
- [x] 決定的述語: `makeNoMainPushPredicate(allowlist)` / `withMainPushAllowlist()`。 許可該当時は
      deny せず warn `main-push-allowlisted` を返し、 audit に残す (黙って素通しにしない)。
- [x] blackbox: 特徴量 `main_push_allowlisted` を追加し、 `no-main-push` シードの `when` を
      `and(command_pushes_main, !main_push_allowlisted)` へ変更。 deny の suggestion に許可リスト名を追記。
- [x] シード upsert: 同 key の旧シードを retire してから現行版を投入し、 Cc 再起動だけで新 `when` が効く。
      (従来の insert-once は fingerprint 変更に追従できず旧ルールが発火し続けた)
- [x] 設定は AdminState `harness.main_push_allowlist` → env `HARNESS_MAIN_PUSH_ALLOWLIST` →
      既定シード `KuzuSurvivors,MakaiNui` の順で **都度解決** (再起動なしで反映)。
      空配列の保存は「例外なし」の明示指定として尊重し、明示設定の破損時も fail-closed にする。
- [x] 設計 §2 のテスト項目を unit / blackbox / API route の各層に実装。

## 実装上の判断 (設計への補足)

blackbox のシードルールを変えるだけでは deny は消えない。 ルール不一致時は LLM フォールバックが
決定的 verdict をそのまま返すため、 決定的述語側の許可リスト対応が必須。 両層で同じ
`isMainPushAllowlisted` を共有させ、 判定規則が二重定義にならないようにした。

## スコープ (編集可ディレクトリ)

- `src/harness/` (main-push-allowlist / predicates / blackbox-engine)
- `src/admin/` (runtime-settings / state)
- `src/api/` (harness-session / register-core)
- `src/config/settings/` (設定レジストリの env 表現 / WebUI 編集経路)
- `tests/`

## 残作業 (別タスク)

- `2026-08-12-completion-blackbox-seed-upsert.md` — 同型のシード insert-once 問題
- `2026-08-12-main-push-allowlist-webui-setting.md` — WebUI 編集経路はレジストリで実装済み。設定変更 audit が残作業
- デプロイ (build → Excubitor 再起動) は設計側の cc-deploy フロー担当。
