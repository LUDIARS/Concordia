---
type: feature
title: "依頼窓口 — 軽い依頼も重い依頼も 1 つの窓口で受け、作業セッションを起動する (Cc v5)"
id: CC-DESK
service: concordia
domain: request-desk
status: draft
related:
  - plan/2026-11-24-control-session-to-dots.md
  - feature/control-cards.md
  - feature/chores.md
  - feature/chores-forum-window.md
updated: 2026-11-24
---

# 依頼窓口 (Cc v5)

> 所属ドメイン: [`request-desk`](../domains/request-desk.domain.json)。設計の正本は [Cc v5 計画](../plan/2026-11-24-control-session-to-dots.md) (実装メモ 1〜13 が優先)。Actio `5075ba3e-56f7-4f53-a732-af3fda910879`。

2026-11-24 neco 指示 (原文):「依頼窓口のチャットを設けて、実行内容に従って人間のアクション、人間の判断が必要なものをカードにして管制が管理するようにCcを改修する」「軽い依頼も重い依頼も全て一つの窓口でやれるようにする」。

## 価値・シナリオ

- 価値: 依頼から実行・人間の手当てまでが 1 本の流れで追える (UX-CC-W5)。Discord と Web のどちらからでも同じ依頼ができる (UX-CC-W2)。
- シナリオ V5-S1 の入口: 人間が依頼窓口に書く → Cc が作業セッションを起動する → セッションが対象プロジェクトに Actio タスクを作って紐付ける → 人間のアクション / 判断はカードになる → セッション終了で依頼は `finished`。

## 業務用語と状態の所有者

| 用語 | 状態の正本 |
|---|---|
| 依頼 (desk request) | `desk_requests` (Cc)。受付元・依頼者・CLI・本文・状態・spawn ID・session ID・Discord のスレッド |
| Actio タスク | Actio。依頼窓口は作らず、起動したセッションが作り `POST /v1/sessions/:id/task-links` で紐付ける (実装メモ 1) |
| セッション本体の会話 | 既存のセッション用 Discord チャンネル / Web チャット (`/sessions/:id`)。依頼窓口には写さない (実装メモ 2) |

状態: `accepted` → `launching` → (`launch_unknown`) → `running` → `finished`、または `launch_failed`。逆戻りしない。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-V5-INV-01 | 受付キー (`web:<client_request_id>` / `discord:<guild>:<message>`) で 1 回だけ受け付ける。同じ中身の再送は同じ依頼を返し、違う中身は 409。起動は spawn ID を先に保存してから 1 回だけ。例外は `launch_unknown` として spawn ID で照合し、5 分で現れなければ `launch_failed`。別の ID で起動し直さない | `src/desk/desk-request-policy.ts` / `dispatcher.ts` |
| CC-V5-INV-06 | API と画面は loopback / 既存の Web SSO の範囲。dots は指令ブリッジだけを使う | `src/api/desk.ts` (app 全体の境界を継承) |
| CC-V5-INV-07 | Discord と Web は同じ `DeskService.submit` を呼ぶ | `src/discord/desk.ts` / `src/api/desk.ts` |

## 構成

- 起動は CDGD 管理の起動と同じ作り (`recordPendingDelegationSpawn({cwd: Castra root, callName: "desk", departmentId, startupInjectText})` → `spawnSession` → `sessions.metadata.concordia_spawn_id` で照合)。部署は設定 `desk.department_id` (空・存在しない ID なら部署なし)。コスト上限中と `desk.enabled` OFF の間は `accepted` のまま待つ。先頭 `[codex]` で Codex のセッションを起動する。
- API: `POST /v1/desk/requests` (Web は `client_request_id`、Discord は `request_key`)、`GET /v1/desk/requests`、`GET /v1/desk/requests/:id` (開いているカードの数・カード・セッションへのリンク)。
- Discord: 旧「雑務窓口」テキストチャンネル (`chores_channel_id`) を「依頼窓口」へ改名して ID・履歴を引き継ぐ (トップレベル)。投稿 1 件 = 依頼 1 件。投稿から `message.startThread` で依頼ごとのスレッドを作り、受付・起動 (セッションのチャンネル / Web チャットへのリンク)・カードの開閉・終了・催促だけを出す。同じ知らせは 2 度出さない (Discord 設定ストアの CAS、結果不明の投稿は繰り返さない)。
- Web `/desk`: 投稿欄 (送信ごとの受付 ID、同じ本文の再送は同じ ID)、依頼の一覧、依頼の詳細 (リンク・カード・[プランと進捗](control-session.md#13-セッションのプランと進捗-cc-v5-実装メモ-13))、過去の雑務 (読み取りと処理中の run の OK / Continue)。`/chores` は `/desk` へ転送する。
- 雑務の新規受付は終了 (`POST /v1/chores` は 410 `chores_retired_use_desk`)。処理中の雑務は従来どおり配達・OK / Continue まで扱う。

## 復旧

- 設定 `desk.enabled` を OFF で新規受付だけ止まる。受付済みの依頼・起動したセッションは影響を受けない。
- 起動が `launch_unknown` のまま残ったら、spawn ID で照合が続き、5 分で `launch_failed` に倒れる。再依頼は新しい投稿として行う。

## 実装の対応

- `src/desk/desk-request-policy.ts` (業務判断)、`service.ts` (受付の use case)、`dispatcher.ts` (起動・照合・終了観測)、`repository.ts` (保存)、`runtime.ts` (組み立て)。
- `src/api/desk.ts`、`src/discord/desk.ts` / `desk-notices.ts` (Discord が使う口の型は `src/desk/discord-port.ts`)。
- Web: `web/src/pages/Desk.tsx` (投稿欄と一覧)、`web/src/pages/desk/DeskDetail.tsx` (依頼の詳細: リンク・カード・プランと進捗)、`web/src/pages/desk/PastChores.tsx` (過去の雑務と処理中の run の OK / Continue)、`web/src/pages/desk/deskLabels.ts` (状態の表示名)。`web/src/pages/Chores.tsx` は `/desk` へ転送する。
- migration 156 `src/db/v5-desk-cards-migration.ts`。

## テスト

`src/desk/desk.test.ts` (受付の冪等・結果不明の照合・起動期限・コスト上限中の待ち)、`src/api/desk.test.ts`、`src/discord/desk.test.ts`、`web/src/pages/Desk.test.tsx`。
