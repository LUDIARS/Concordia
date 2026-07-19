---
type: feature
title: "エラー集約パイプライン + 自動修正"
description: "Vestigium ログや Discord 操作失敗を error.reported イベントで集約し、Discord「エラー」チャンネルへ転記する (PR #81 済)。さらに常駐 error-fixer Codex セッションへ自動修正依頼を inject する経路を実装。レート制御・dedupe・spawn cooldown・安全弁 env を備える。"
service: concordia
domain: observability
tags:
  - typescript
  - event-driven
  - polling
  - monitoring
  - auto-fix
  - llm
  - relay
  - codex
  - discord
status: implemented
updated: 2026-06-30
---


# エラー集約パイプライン + 自動修正

> 監視ロガー検知 / Concordia 内部失敗を Discord「エラー」カテゴリへ集約し、
> さらに常駐 error-fixer Codex に自動修正させる経路。

## 1. 集約 (PR #81, merged)

- `error.reported` イベント (`src/events.ts`) + `reportError()` (`src/errors.ts`)。
- 取り込み源:
  - **監視ロガー** — `src/discord/error-monitor.ts`。 env `CONCORDIA_ERROR_WATCH_LOGS_ROOT`
    指定時、 Vestigium ログ (`<root>/<service>/YYYY-MM-DD.jsonl`) の error/fatal を
    30s poll → `reportError("vestigium:<service>", …)`。 未指定なら no-op。
  - **Discord 操作失敗** — `bot.ts` の `log.warn`/`log.error` が失敗ログ
    (`looksLikeFailure`) を `reportError("discord", …)` へ転送。
- 転記先: Discord「エラー」カテゴリ + `errors` チャンネル (`config.ts`)。
  `src/discord/error-channel.ts` の `ErrorChannelPoster` がレート制御 + 同一畳み込み
  + 自身の送信失敗は専用 logger で握り潰し (再帰ループ防止)。

## 2. 自動修正 (本 PR)

`error.reported` を購読し、 **常駐 error-fixer Codex** に修正依頼を inject する
(`src/control/error-fix.ts`)。

- **安全弁**: env `CONCORDIA_ERROR_AUTOFIX=1` の時だけ稼働 (既定 OFF)。
- **対象フィルタ** (`shouldFixError`): `vestigium:*` を主対象 + `discord` の非一過性失敗。
  rate-limit / timeout / unavailable / 5xx 等の一過性と、 `error-autofix` 自身 (ループ) は除外。
- **同一セッション**: fixer は「`repo_path === fixerCwd` の active codex-cli セッション」 で同定。
  `fixerCwd` = env `CONCORDIA_ERROR_AUTOFIX_CWD` ?? `config.spawnDefaultCwd`。
  居なければ一度だけ `spawnSession({provider:"codex", cwd:fixerCwd})` (spawn cooldown 120s)。
  以後は同じセッションに inject して再利用する。
- **inject**: `session.inject` event (Lictor が WS 経由で Codex TUI に流す。
  `auto-session-end-inject.ts` と同経路)。 prompt は `buildErrorFixPrompt`:
  source/message/detail + 対象リポ推定 + 「fix ブランチ→commit→push→PR 作成で停止」。
  テスト、CI 修正継続、merge、auto-merge、main 更新はユーザの明示指示が必要。
- **dedupe / rate-limit**: 同一 (source|message) は 10 分以内再依頼しない。
  inject 間隔は最小 120s、 滞留は queue (上限 20) に積んで 30s tick で drain。

### 既知の制約 / 将来
- fixer の cwd は 1 つ。workspace root は指定せず、個別プロジェクトの cwd を設定する。
  クロスリポ修正は対象プロジェクトを特定してから、そのリポの Session として扱う。
- spawn→session_id の同定は cwd 一致ヒューリスティック。 より厳密にするなら Lictor 側で
  「role=error-fixer」 マーカーを registration metadata に伝播させる契約が要る (将来)。
- Vestigium ライブ検知の本体は Excubitor (別サービス) にあり、 Concordia 側は env で
  ログ root を指す簡易 tail。 Excubitor からの push 連携は将来検討。
