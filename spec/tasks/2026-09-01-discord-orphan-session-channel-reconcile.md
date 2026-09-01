---
task: discord-orphan-session-channel-reconcile
project: Concordia
kind: 実装
created: 2026-09-01
memory_links: [1709]
---
# Discord セッションチャネルの孤児 reconcile と終了時同時閉鎖

## 目的

`discord_session_channels` に active のまま残る、対応する `sessions` 行のないゴーストチャネルを閉じる。
2026-09-01 時点では active 55 行のうち 33 行がこの状態だった。

## 原因

既存の終了 reconcile は read model から sessions の status が `ended` と読める場合だけを対象にしていた。
retention や削除経路で sessions 行が先に消えると status は取得不能になり、Discord 側の active 行は永続的に skip される。
また delegation run の completed/failed と sessions 削除の DB transaction は、対応する Discord channel 行を終了させていなかった。

## 対策

- scope を保った orphan 検出 SQL と、既存 `onSessionStatusChanged(... ended)` を再利用する reconcile を追加する。
- 起動時・10 分ごとの forum reconcile から実行し、`CONCORDIA_DISCORD_ORPHAN_RECONCILE_DRY_RUN=1` では件数と channel ID のログだけを出す。
- delegation の terminal status と sessions 削除では、同一 DB transaction で channel row を `ended` にする。Discord API archive は次回 reconcile に委ねる。
- orphan / 通常 session / delegation 完了の回帰テストを追加する。

## 完了条件

- sessions 行なしの active Discord channel は reconcile 後に ended かつ archive される。
- sessions 行がある active channel は orphan reconcile の対象外である。
- delegation の completed/failed と session purge は channel row も同一 transaction で ended にする。
- マージ後は Concordia の build と再起動が必要。今回確認された 33 本の実走掃除は Excubitor 管理の本体 (`dist` 実行) で行い、worktree からは起動しない。

## スコープ (編集可ディレクトリ)

- `src/db/discord-repo.ts`, `src/db/sessions-repo.ts`, `src/db/delegation-repo.ts`
- `src/discord/session-channel.ts`, `src/discord/bot.ts`
- 対応する unit test と `spec/domains/agent-delegation.domain.json`
