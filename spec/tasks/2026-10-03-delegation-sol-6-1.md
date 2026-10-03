---
task: 2026-10-03-delegation-sol-6-1
project: Concordia
kind: 実装
created: 2026-10-03
memory_links: []
reference: director:dir_5bb8a9bfe46940738c3fa4819c8861c4
---
# Delegation の Sol を gpt-6.1-sol にし、Astra xhigh を廃止する

プラン v1 (Director case `dir_5bb8a9bfe46940738c3fa4819c8861c4`) を 2026-10-03 に人間が承認。
neco 指示「Delegation の Sol を 6.1 にしてほしい」「Astra の xhigh を消して」「これだけファストレーン使ってマージ」。

## 目的

委託テンプレートのうち sol-mid / sol-xhigh だけが gpt-6.1-sol で、残り 8 本 (forum-codex-session / impl-from-design / fix-bug /
refactor / github-issue-fix / ludiars-status-daily / ludiars-review-daily-dual / notion-ai-note) は gpt-6-sol 固定のまま。
seed が起動のたびにモデルを上書きするので、DB だけ直しても再起動で戻る。

## 受け入れ条件

- [x] seed の Sol テンプレートのモデルが、モデル一覧の Sol (role-policy の INITIAL_ROLE_MODELS.sol = gpt-6.1-sol) を参照する (直書きの gpt-6-sol が無い)。
- [x] 既存 DB で model='gpt-6-sol' の委託テンプレートが、新しい migration で gpt-6.1-sol になる (seed に無い notion-ai-note も含む)。migration 凍結台帳に 1 件追加。
- [x] astra-xhigh を seed から外し、LEGACY_DELEGATION_CALL_NAMES に入れて起動時に定義行を削除する (run の履歴は残る)。
- [x] spec/feature/delegation.md の表から astra-xhigh を外し、Sol の既定モデルを 6.1 にする。
- [x] seed / migration のテストを更新し、tsc と関係テストが通る。
- [ ] local PR をファストレーンで提出し、Test OK 後にマージ・Cc へ反映 (build + Excubitor 再起動) する。

## タスク分解

1. seed.ts: SOL_MODEL = initialRoleModel("sol") を参照し、astra-xhigh を削除・LEGACY に追加。
2. schema.ts: migration 128「delegation-sol-6-1」: UPDATE delegation_templates SET model='gpt-6.1-sol' WHERE model='gpt-6-sol'。台帳に凍結値を追加。
3. テスト更新 (seed.test.ts / migration-ledger)、tsc + 関係テスト。
4. spec 更新、ファストレーンで local PR 提出 → マージ → 反映。

## 復旧

- migration は値の更新だけで列・表を変えない。戻すときは逆の UPDATE を次の migration で行う。
- astra-xhigh を戻すときは LEGACY から外して seed に戻す (run 履歴は template_id=NULL で残っている)。

## 実施結果

- seed.ts: Sol テンプレート 7 本 + review-duo のプロンプト文を `SOL_MODEL = initialRoleModel("sol")` に置き換えた。旧値 gpt-6-sol は sol-mid / sol-xhigh の追従判定 (旧既定からの移行) にだけ残る。
- schema.ts: migration 128 `delegation-sol-6-1` (値の更新のみ、スキーマ指紋は不変)。SCHEMA_VERSION 128、台帳に凍結値を追加。
- astra-xhigh を seed から外し LEGACY_DELEGATION_CALL_NAMES へ。
- 検証 (実施): tsc --noEmit エラー 0。vitest — seed.test.ts / migration-ledger.test.ts / delegation-sol-migration.test.ts (新規) / tests/delegation-regression.test.ts / internal-agent-policy / role-policy が通過。
- 検証 (未実施): 反映後の稼働 DB で 8 本が gpt-6.1-sol・astra-xhigh が消えたことの確認 (反映後に行う)。
