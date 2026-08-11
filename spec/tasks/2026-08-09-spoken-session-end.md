---
task: spoken-session-end
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# 発話でのセッション終了と、閉じた投稿の閉じ直し

## 目的

2026-08-09 neco 指摘の 2 点。

1. 「セッション終了」と発言してもプロセスが閉じず、`/end-session` を別途叩く手間があった。
2. 一度 close した Discord 投稿へ書き込むと Discord が再 open するのに、誰も閉じ直していなかった。

## 完了条件

- 発話が終了指示なら metadata に印が付き、そのターンが静かになった時点で `/end-session`
  相当 (`endSessionNow`) が走る。上限時間を超えたら静かでなくても終了する。
- 発話経路にも `/end-session` と同じ `session_end` capability を要求し、未認可の発話は
  inject せず終了要求にも変換しない。
- 終了処理が HTTP ルートと watcher で 1 つの関数に集約されている。
- close 済みスレッドへの書き込み (controls 更新 / render / update / status 投稿) の後、
  元が閉じていたスレッドは閉じ直される。
- 検知と選別に単体テストがある。

## スコープ (編集可ディレクトリ)

- `src/control/end-session-command.ts`, `src/control/end-session-request.ts`
- `src/api/sessions/lifecycle.ts`, `src/discord/ingress.ts`, `src/bootstrap/core.ts`
- `src/discord/thread-archive.ts`, `src/discord/test-forum-discord.ts`
- `spec/feature/session-end-request.md`

## 未対応 (別途判断が必要)

- session forum スレッド (ended セッションの面) の再 open は、定期 reconcile
  (`CONCORDIA_DISCORD_STATUS_RECONCILE_SEC`) が既定 0 = 無効のため今も閉じ直されない。
  常時 reconcile を有効化するかは運用判断なので、このタスクでは触らない。
