---
type: feature
title: "依頼窓口 — Actio に受け付け、プロジェクト管制へ届ける (Cc v5)"
id: CC-DESK
service: concordia
domain: request-desk
status: draft
related:
  - plan/2026-11-24-control-session-to-dots.md
  - feature/control-cards.md
  - feature/chores.md
  - feature/chores-forum-window.md
updated: 2026-11-25
---

# 依頼窓口 (Cc v5)

> 所属ドメイン: [`request-desk`](../domains/request-desk.domain.json)。設計の正本は [Cc v5 計画](../plan/2026-11-24-control-session-to-dots.md) (実装メモ 1〜13 が優先)。Actio `5075ba3e-56f7-4f53-a732-af3fda910879`。

## Actio による依頼の割り当て

Actio `actio:8049bc2f-78ab-488a-b479-0242f5db464d` の変更範囲では、この節を従来の起動仕様に優先する。UX-CC-W2/W5、V5-S1、CC-INV-01/02/03/04/07/08 に対応する。

- 受付は Web・Discord および指令元が同じ use case を使う。登録済みプロジェクトを明示指定、または本文の登録名・略号から一意に判定する。曖昧な場合は、依頼詳細から対象を選べる管制判断カードを出す。選択後に対象を固定し、`desk:<request_id>` を Actio の作成キーとする。
- 依頼窓口は受付、対象、Actio 参照、管制の起動予約、受け箱の配達と委託受付を所有する。Actio が本文、実行担当、完了状態を所有し、委託ドメインが子の起動と結果を所有する。受付の本文は窓口表示と作成の再照合に使う。
- 各本社プロジェクトに専任のプロジェクト管制セッションを 1 つ置く。プロジェクトの最新の起動予約 ID、専任ロール、リポジトリと稼働状態が一致するセッションだけに払い出す。管制がなければ対象の本体で既存の spawn を使う。プロジェクトごとに起動の予約は 1 件、全体で確認待ちは 4 件、常駐と起動待ちの合計は 8 件までとする。起動失敗または登録確認の 5 分経過は管制アクションカードに出す。旧世代が復帰しても新世代の予約がある間は受け付けない。
- Actio 参照を永続化された受け箱に保持し、管制が応答可能な区切りで既存の inject を使う。管制は既存の `POST /v1/desk/requests/:id/claim` で委託を受け付ける。Cc が `sol` の委託経路へ既存参照と管制セッション ID を渡し、子が実装と成果提出を担当する。同一プロジェクトで受付済みと起動待ちを含め 2 件までを払い出し、それ以降は受け箱に残す。画面の管制担当と、Actio に記録する実行担当をそれぞれ追跡できる。
- 管制が終了・停滞した場合は新しい管制を起動し、未完了の依頼を引き継ぐ。復帰した旧管制には、子を保持したまま自身を終了するよう案内する。子がまだ稼働中なら同じ run を監督する。管制は子の進捗・結果を確認し、停滞時は既存の継続・終了経路で作業を保全する。成果提出がなく失敗が確定し子の終了を確認できた場合は、同じ Actio 参照で 1 回再委託する。結果不明、確認待ち、再失敗はカードに残す。終了・取消は Actio から観測し、委託の成功だけで完了にはしない。
- 旧依頼は旧起動の照合と終了観測を継続する。複数依頼で同じセッションを使う場合、その共有会話へのリンクを表示する。依頼ごとの Discord スレッドは引き続き受付・割り当て・状態の通知先とする。
- Web の依頼詳細は、委託先の子セッション ID が返ったときに実行セッションへのリンクを表示する。プロジェクト管制のチャットへのリンクは引き続き表示する。
- dots と管制は `POST /v1/instructions/desk-requests` に `request_id`、`body`、任意の `project` と `provider` を送る。外部 dots は指令ブリッジの認証を使用する。管制は loopback で自身の `session_id` を指定する。再送には同じ `request_id` を使う。本社のプロジェクトとセッションを対象とする。

2026-11-24 neco 指示 (原文):「依頼窓口のチャットを設けて、実行内容に従って人間のアクション、人間の判断が必要なものをカードにして管制が管理するようにCcを改修する」「軽い依頼も重い依頼も全て一つの窓口でやれるようにする」。

## 価値・シナリオ

**CC-DESK-GEN5 (UX-CC-W5)**　依頼を選ぶと Web 窓口は紐付いた受付セッションのチャットを同じ画面に表示する。返信・質問への回答・権限判断・履歴は既存の session-chat が所有する。別の依頼に切り替えた際に旧チャットや送信先を引き継がない。

Gen5 の現在工程は受付担当が回答先頭の `Gen5工程: <工程名>` で明示した最新の有効な報告。工程は表示用で、試遊完了・Actio の状態・実行許可を変更しない。記録が無ければ未報告と表示する。質問と判断は受付セッションに集約し、そのセッションを所有者とする管制カードの種類・状態・要点を表示する。再読込は保存済みの発言とカードから復元する。

- 価値: 依頼から実行・人間の手当てまでが 1 本の流れで追える (UX-CC-W5)。Discord と Web のどちらからでも同じ依頼ができる (UX-CC-W2)。
- シナリオ V5-S1 の入口: 人間が依頼窓口に書く → Cc が対象プロジェクトに Actio タスクを作る → 専任管制が委託を受け付ける → 子が作業し判断や成果を記録する → Actio の終了状態を窓口で確認できる。

## 業務用語と状態の所有者

| 用語 | 状態の正本 |
|---|---|
| 依頼 (desk request) | `desk_requests` (Cc)。受付元・依頼者・CLI・本文・状態・spawn ID・session ID・Discord のスレッド |
| Actio タスク | Actio。Cc が受付キーと対応するタスクを作り、委託の実行担当と完了状態を照合する |
| セッション本体の会話 | 既存のセッション用 Discord チャンネル / Web チャット (`/sessions/:id`)。依頼窓口には写さない (実装メモ 2) |

状態: `accepted` → `launching` → (`launch_unknown`) → `running` → `finished`、または `launch_failed`。逆戻りしない。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-V5-INV-01 | 受付キー (`web:<client_request_id>` / `discord:<guild>:<message>`) で 1 回だけ受け付ける。同じ中身の再送は同じ依頼を返し、違う中身は 409。起動は spawn ID を先に保存してから 1 回だけ。例外は `launch_unknown` として spawn ID で照合し、5 分で現れなければ `launch_failed`。別の ID で起動し直さない | `src/desk/desk-request-policy.ts` / `dispatcher.ts` |
| CC-V5-INV-06 | API と画面は loopback / 既存の Web SSO の範囲。dots は指令ブリッジだけを使う | `src/api/desk.ts` (app 全体の境界を継承) |
| CC-V5-INV-07 | Discord と Web は同じ `DeskService.submit` を呼ぶ | `src/discord/desk.ts` / `src/api/desk.ts` |

## 構成

- 起動は `recordPendingDelegationSpawn` → `spawnSession` → `sessions.metadata.concordia_spawn_id` の順に既存経路で照合する。部署は設定 `desk.department_id`。旧依頼は Castra root の従来経路で照合する。コスト上限中は新規起動・委託を待つ。プロジェクト管制の手順は [プロジェクト管制スキル](../../skills/cc-project-control/SKILL.md) と起動時の案内で共有する。
- API: `POST /v1/desk/requests` (Web は `client_request_id`、Discord は `request_key`)、`GET /v1/desk/requests`、`GET /v1/desk/requests/:id` (開いているカードの数・カード・セッションへのリンク)。
- Discord: 旧「雑務窓口」テキストチャンネル (`chores_channel_id`) を「依頼窓口」へ改名して ID・履歴を引き継ぐ (トップレベル)。投稿 1 件 = 依頼 1 件。投稿から `message.startThread` で依頼ごとのスレッドを作り、受付・起動 (セッションのチャンネル / Web チャットへのリンク)・カードの開閉・終了・催促だけを出す。同じ知らせは 2 度出さない (Discord 設定ストアの CAS、結果不明の投稿は繰り返さない)。
- Web `/desk`: 投稿欄 (送信ごとの受付 ID、同じ本文の再送は同じ ID)、依頼の一覧、依頼の詳細 (リンク・カード・[プランと進捗](control-session.md#13-セッションのプランと進捗-cc-v5-実装メモ-13))、過去の雑務 (読み取りと処理中の run の OK / Continue)。`/chores` は `/desk` へ転送する。
- 雑務の新規受付は終了 (`POST /v1/chores` は 410 `chores_retired_use_desk`)。処理中の雑務は従来どおり配達・OK / Continue まで扱う。

## 復旧

- 設定 `desk.enabled` を OFF で新規受付だけ止まる。受付済みの依頼・起動したセッションは影響を受けない。
- 起動が `launch_unknown` のまま残ったら、同じ spawn ID で照合を続け、5 分で `launch_failed` とする。依頼詳細の再試行で同じ Actio 参照を使う。

## 実装の対応

- `src/desk/desk-request-policy.ts` (業務判断)、`service.ts` (受付の use case)、`dispatcher.ts` (起動・照合・終了観測)、`repository.ts` (保存)、`runtime.ts` (組み立て)。
- `src/api/desk.ts`、`src/discord/desk.ts` / `desk-notices.ts` (Discord が使う口の型は `src/desk/discord-port.ts`)。
- Web: `web/src/pages/Desk.tsx` (投稿欄と一覧)、`web/src/pages/desk/DeskDetail.tsx` (依頼の詳細: リンク・カード・プランと進捗)、`web/src/pages/desk/PastChores.tsx` (過去の雑務と処理中の run の OK / Continue)、`web/src/pages/desk/deskLabels.ts` (状態の表示名)。`web/src/pages/Chores.tsx` は `/desk` へ転送する。
- migration 156 `src/db/v5-desk-cards-migration.ts`。

## テスト

- Actio `actio:b83d93f2-145b-41f1-9b10-38a2bc3df0d3`（2026-11-26、Revisor #4194 の全件テストで配達順の検査が失敗）。受付待ちの二件が枠を保持し、先行依頼の終了観測で三件目が配達されることを、注入した時計と dispatcher の処理完了を使って確認する。同じ時刻に処理可能な依頼はすべて処理してから配達を検査する。

`src/desk/desk.test.ts` (受付の冪等・結果不明の照合・起動期限・コスト上限中の待ち)、`src/api/desk.test.ts`、`src/discord/desk.test.ts`、`web/src/pages/Desk.test.tsx`。
