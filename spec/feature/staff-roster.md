---
type: feature
title: "社員名簿 (役職権限登録リスト)"
description: "Concordia の LLM に触れる Discord / Slack ユーザを staff_members へ記録し、3 段階の役職 (ヒラ社員 / 管理職 / 執行役員) で権限を決める台帳。リアクションワークフロー設定に同居していた user ID allowlist を廃止し、リアクション発火・セッション spawn / end-session・キルスイッチの認可をこの名簿へ一本化する。判定関数が未注入なら deny (fail-closed)。"
service: concordia
domain: governance
tags:
  - authorization
  - discord
  - slack
  - sqlite
  - typescript
  - webui
status: implemented
owner: Concordia
related:
  - subsidiary-delegation.md
  - task-workflow.md
  - trust-boundaries.md
  - reaction-workflow.md
updated: 2026-07-30
---

# 社員名簿 (役職権限登録リスト)

## 1. 目的

Concordia の LLM に触れる platform ユーザ (Discord / Slack) を台帳に記録し、 **役職**で
権限を決める。 従来は「発火・セッション起動ユーザー allowlist」をリアクションワークフロー
設定の中に置いていたが、 これは

- リアクションワークフローと無関係な spawn / end-session の権限まで同じ allowlist で
  判定していた (責務が混ざっていた)、
- 「誰が触ったか」の記録が無く、 ID を手で貼り付けるしかなかった、

という 2 点で運用に耐えなかった。 本機能はこれを「社員リスト = 役職権限登録リスト」として
独立した UI + データに切り出す。

Cernere (認証・個人データ) との連携は将来の検討事項とし、 現時点では Concordia 単独で
運用する (Memoria タスクに登録済み)。

## 2. 記録

LLM に届く経路 (Discord ingress のメッセージ / リアクション、 Slack の message /
reaction_added) を通ったユーザを `staff_members` へ upsert する。

- 記録時に**サーバーでのプロファイル名**を取る。 Discord は guild nickname
  (`msg.member.nickname` → `displayName`)、 併せて global name も保持する。
  Slack はイベントにサーバー表示名が無いので user ID のみ記録し、 表示名は WebUI で補う。
- 記録は台帳であって権限付与ではない。 初回は必ず `role='staff'` (ヒラ社員)。
- 再アクセス時に役職は絶対に上書きしない。 名前は「取得できたときだけ」上書きし、
  空文字で既存の名前を潰さない。

## 3. 役職 (3 段階固定)

権限ごとにマニュアルやハーネスルールを個別に作るのは運用コストが高いため、 3 段階に固定する。
上位は下位を包含する。

| 役職 | 値 | できること |
| --- | --- | --- |
| ヒラ社員 | `staff` | 会話 (chat 投稿 / inject) と**リアクションでの指示**。 **登録なし / 権限なしのユーザもこれと同じ扱い** |
| 管理職 | `manager` | 上記 + セッションの spawn / end-session / **PR のマージ** |
| 執行役員 | `executive` | 上記 + キルスイッチ (Excubitor 経由のサービス起動・再起動) |

操作 → 必要役職の対応は `src/staff/roles.ts` の `CAPABILITY_MIN_ROLE` が唯一の正本
(フロントは `/v1/staff` が返す凡例を描くだけで、 判定ロジックを持たない)。

| capability | 最低役職 | 実際のゲート位置 |
| --- | --- | --- |
| `converse` | staff | ゲートなし (未登録でも通す) |
| `reaction_workflow` | **staff** | 発火自体は誰でも可 (下記) |
| `session_spawn` | manager | `/spawn`・`ctrl:spawn*`・forum spawn・Slack `/concordia spawn` / delegation invoke・🤝 `delegate-task`・🛠️ `add-as-workflow` (§8) |
| `session_end` | manager | `/end-session`・`ctrl:end-session*`・Slack `/concordia end` |
| `merge_pr` | manager | 🔀 🚀 `merge-pr`・🔄 `sync-project-main-after-merge` (runner の `handle()` 入口) |
| `kill_switch` | executive | `/ex-run`・`/ex-reboot` |

判定関数が未注入の場合は **deny** (fail-closed)。 名簿が配線されていない環境で権限操作を
通してはならない。

## 4. allowlist の廃止

- `src/shared/reaction-workflow-auth.ts` (allowlist パーサと `*` 全員許可トークン) を削除。
- `AdminState` / `WorkflowSettingsStore` から user ID の getter/setter を削除。
- `PUT /v1/admin/reaction-workflow` は `{ enabled }` のみ受ける (`discord_user_ids` /
  `slack_user_ids` を送ると 400)。
- readiness (`no_authorized_users`) の判定は「権限を要する指示を実行できる社員 (管理職以上)
  の人数」に置き換え (§8 参照。 発火自体は誰でもできる)。 `allow_all` フィールドは無くなった。
- **移行 (migration 44)**: 旧キー `admin.reaction_workflow_{discord,slack}_users` の ID を
  `role='manager'` として名簿に投入する。 これが無いと移行直後に spawn できる人間が 0 人に
  なる。 永続値が無い環境では廃止 env `CONCORDIA_REACTION_WORKFLOW_{DISCORD,SLACK}_USERS`
  (カンマ / 空白 / `;` 区切り) を同じ扱いでフォールバック取り込みする — GUI を一度も触らず
  env だけで運用していた環境も締め出さないため。 `*` は役職に翻訳できないので捨てる —
  「全員許可」を残すと権限モデルが最初から無意味になるため。

## 5. データ / API

`staff_members` (PK = `(platform, platform_user_id)`):
`display_name` / `profile_name` / `role` / `note` / `first_seen_at` / `last_seen_at` /
`updated_at`。

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/v1/staff` | 名簿 + platform×役職の件数 + `has_executive` + 役職/権限の凡例 |
| POST | `/v1/staff` | 手動登録 (まだ発言していないユーザに役職を先付け) |
| PATCH | `/v1/staff/:platform/:userId` | 役職 / メモの更新 |
| DELETE | `/v1/staff/:platform/:userId` | 名簿から削除 (次の発言でヒラ社員として再記録) |

認証は他の `/v1` と同じ loopback 前提。 名簿が権限の正本なので、 触れるのは WebUI のみ。

## 6. WebUI

`/staff` (ナビ「社員」)。 名簿一覧 (プロファイル名・platform・ID・現在の役職・役職変更
select・メモ・最終アクセス・削除)、 platform フィルタ、 役職/権限の凡例、 手動登録フォーム。

警告バナー:

- **執行役員が未登録** — キルスイッチを踏める人が居ない。
- **管理職以上が 0 人** — spawn / end-session / 発火が全員 Deny。

設定ページのリアクションワークフロー節は allowlist 入力欄を失い、 発火権限保持者の人数と
社員ページへのリンクだけを表示する。

## 7. 残課題

- Cernere との連携 (個人データ単一情報源への寄せ) — Memoria タスクで追跡。
- Slack のサーバー表示名取得 (`users.info`) は未実装 (user ID のみ記録)。

## 8. リアクションワークフローは権限ではない (neco 決定 2026-08-01)

リアクションは**指示の簡略化**であって権限ではない。 絵文字は誰でも押せる —
ただし「指示の内容が実行できるとは限らない」。 中身が破壊的操作を要求するなら、
そこで改めて役職が問われる。

| アクション | 追加で要求する権限 |
| --- | --- |
| 🤝 `delegate-task` (別セッションを起動する) | `session_spawn` |
| 🔀 🚀 `merge-pr` (PR を着地させる) | `merge_pr` |
| 🔄 `sync-project-main-after-merge` (main を書き換える) | `merge_pr` |
| 🛠️ `add-as-workflow` (任意プロンプトを絵文字に束ねて保存する) | `session_spawn` |
| 上記以外 (洗い出し・記録・状況報告など AI への作業指示) | 不要 |

🛠️ だけは「指示」ではなく**設定の永続化**なので閉じてある。 カスタムワークフローは
組み込み写像に該当しない絵文字だけを拾う分岐 (`handle()` の写像照合が空振りした側) で
走り、 この権限判定を通らない。 登録を開けると「マージせよ」というプロンプトを登録して
押す、という迂回路になるため、 登録側を管理職以上に閉じてこの経路を塞ぐ
(登録済みワークフローの発火自体は誰でも可)。

対応表は `src/platform/reaction-workflow-capability.ts` が正本。 判定は runner の
`handle()` 入口で行い、

- **dedup より先に見る** — 拒否で cooldown を消費すると、 役職を付けた直後に押し直せない
- **黙って無視しない** — 押した本人へ「何の権限が足りないか」を返す
- ただし**拒否の通知だけは間引く** — リアクションは付け外しが自由なので、 毎回返すと
  拒否された側が chat を埋め尽くせる。 通知用の cooldown は発火用と名前空間を分けて持ち、
  役職が付いた直後の押し直しは即座に通る (ログは間引かず毎回残す = 監査用)
- 判定関数が未注入なら deny (fail-closed)

これに伴い readiness (`no_authorized_users`) の意味も変わった。 発火できる人数ではなく
**権限を要する指示を実行できる社員 (管理職以上) の人数**を数える。 0 人ならワークフローを
ON にしても「押せるが spawn も merge も起きない」状態になるため、 警告する価値がある。
