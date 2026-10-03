---
task: 2026-10-03-budget-discord-roles-codex-consult
project: Concordia
kind: 実装
created: 2026-10-03
memory_links: []
actio_reference: actio:219a92fa-94e3-4096-9074-9fda4fc72181
---
# 予算の倍率を Discord のロールで決める・Astra (codex) の相談を専用 CODEX_HOME とフックで閉じる・役職フォルダの指示とスキルを共通化

設計正本: `spec/feature/usage-budgets.md` §3.1 §4 §6 §7、`spec/feature/tech-consultation.md` §6。
タスク本文は Actio (`actio:219a92fa-94e3-4096-9074-9fda4fc72181`) を参照する。

## 分解

### A. 予算の属性倍率を Discord のロールにする

1. migration 125: `usage_budget_role_multipliers` を Discord のロール id キーに作り直す (旧値は捨てる)。repo を合わせる。
2. cost: `lowestRoleMultiplier` と `DiscordRoleMultiplierResolver` (人ごと 5 分キャッシュ、失敗は 1)。tracker の倍率を非同期対応にする。
3. Discord: Bot の共有 Client から人のロールと guild のロール一覧を読む (`member-roles.ts`、`DiscordGatewayPool.readyClients`)。
4. API: 倍率をロール id で設定、`GET /v1/usage-budgets/discord-roles`。WebUI はロール一覧からロールごとに入力する。

### B. Astra (codex) の相談を専用 CODEX_HOME とフックで閉じる

1. `consultCodexHome` と CODEX_HOME の準備 (hooks.json・config.toml、ログイン確認)。未ログインは 503 `projectless_consult_codex_login_required`。
2. フック `tools/consult-codex-hook.mjs` (PreToolUse → ハーネス判定、SessionStart → transcript 報告)。
3. codex のログ親の登録 (`setExtraCodexSessionRoots`)。

### C. 役職フォルダの指示とスキルを共通化する

1. codex の引数を `project_doc_max_bytes=0` から `project_root_markers=[]` へ (役職フォルダの AGENTS.md を読ませる)。
2. `.agents/skills` を正本にし、`.claude/skills` を junction で張る (`consult-role-skills.ts`)。
3. codex への初回指示は AGENTS.md を載せず、スキル本文 (と移行前の CLAUDE.md) だけにする。

## 完了条件

- [x] A〜C の実装と同じ変更での単体・API・結合テスト、Augur 契約 `budget-role-C-1` / `consult-codex-C-2` / `consult-codex-C-3` / `consult-skills-C-4`。
- [x] spec (usage-budgets.md / tech-consultation.md / departments.md)、`cc.acceptance.json`、`spec/domains/consultation.domain.json`、Augur テスト台帳。
- [ ] 反映後、相談の CODEX_HOME へログインし `/hooks` で 2 つのフックを信頼する (人)。
- [ ] 反映後、既存の役職フォルダの CLAUDE.md と `.claude/skills` を AGENTS.md と `.agents/skills` へ移す (人)。
- [ ] 反映後、社員名簿の画面でロールごとの倍率 (例: 新入部員・メンター 0.5) を入れる (人)。
