---
type: feature
title: "Delegation coordination API"
description: "Parent-child delegation run coordination: parent_session_id/child_session_id linkage, child status updates, parent-to-child inject, parent filtered run listing, invoke overrides, spawn env propagation, and Discord mirroring through the parent session channel."
service: concordia
domain: governance
tags:
  - delegation
  - sqlite
  - rest-api
  - session-coordination
  - injection
  - discord
  - spawn
  - lifecycle
status: implemented
related:
  - feature/delegation.md
  - feature/discord-ui.md
  - feature/task-workflow.md
  - setup/spawn.md
updated: 2026-07-07
---

# Delegation 協働管理 — 親↔子 API + Status/Inject + Discord 挙動

親 (active セッション) が delegation で投げた子タスクを、Cc を介して監視・制御する。
既存の delegation 基盤 (テンプレ / run / spawn / 「外注」欄 / metadata.delegation_run_id)
の上に、親子リンク・状態更新・inject・Discord 挙動を足す。

> Status: 設計確定 (実装は別セッション)。設計判断が要った点は本文に「設計判断」として明記。

## 1. 親子リンク

`delegation_runs` に 2 列追加 (migration):
- `parent_session_id` — invoke を呼んだ active セッション。
- `child_session_id` — spawn された子が register 時に自分の `delegation_run_id` で claim して紐付く。

これで `run ↔ 親 ↔ 子` が双方向に引ける。

## 2. テンプレとモデル上書き

役割別 base テンプレ (既存を流用/整理):
- **調査** → Sonnet 5 (`claude-sonnet-*-impl` 系)
- **実装** → Codex 5.5 (`codex-5-5`)
- **設計・レビュー等の高度処理** → Fable 5 / Sonnet 5
  (codex/GPT 系で起動中に設計する時はこちらへ振る)

invoke で **各パラメータをモデル含め上書き可**:
- `POST /v1/delegation/invoke` に `overrides: { model?, provider?, reasoning_effort? }` を追加。
  未指定はテンプレ既定。
- 設計判断: モデル呼称は Fable 5 / Sonnet 5。 起動側の「GPT54」は codex GPT-5.4 系を指す
  (正確な model id は実装時に codex-cli の対応表で確定)。

## 3. 状態ライフサイクル + Status API 【未実装】

- invoke → run=`spawned` → 子 register で `child_session_id` 紐付け → run=`running`。
- **子 → 親 ステータス更新** (新規・必須):
  `POST /v1/delegation/runs/:id/status { status: "running"|"completed"|"failed", detail?, result? }`
  - `completed` / `failed` で run を更新し、 **親セッションへ inject 通知**する (§5 の通り Discord にも投稿)。
  - 失敗も同 API で `failed` を送る (黙って終わらせない)。
- **親が監視**: `GET /v1/delegation/runs?parent_session=<id>` (状態一覧) / `GET /v1/delegation/runs/:id`。

## 4. 親 → 子 Inject (追加タスク)

- `POST /v1/delegation/runs/:id/inject { text }` → run.child_session_id の `session.inject` に中継。
- 子は委託 context の指示で追加 inject を受理して継続する (§7)。

## 5. Discord 挙動

- delegation spawn は **Discord セッションチャンネルを生成しない**。WebUI「外注」カテゴリにのみ出す。
- 子で**権限承認・確認が必要**なものは、直接 Discord ではなく **親セッション経由**でやりとりする
  (子→run→親へ要求を中継、親が回答を子へ inject)。専用 API は設けず §3 status + §4 inject で回す
  (設計判断: 将来必要なら `/runs/:id/approval` を追加)。
- 子は **Cc からの Inject を受理**する。
- **Cc 発の Inject メッセージは Discord にも手投稿する** (status 通知・追加タスク inject 等の
  Cc 起源メッセージを Discord 上でも可視化)。
  - 設計判断: 投稿先は対象セッションの session channel。子 (channel を持たない外注) 宛は
    **親の session channel にミラー投稿**する (人間が親スレッド上で協働を追える)。

## 6. 並列タスク / 実行キュー

- §2 の invoke を並列に複数投げる。各 run は §3/§4 で独立追跡。
- **同時実行上限 (キュー)**: 無制限に spawn すると Concordia ホストのリソースが枯れるため、
  同時に走る run の数に上限を設ける (既定 4、 `0` で無制限 = キュー無効)。
  上限は AdminState (`admin.delegation_max_concurrency`) に永続化し、
  `GET/PATCH /v1/delegation/queue` で参照・変更する (引き上げ時はその場で払い出す)。
  - 上限超過の invoke は **spawn せず `status='queued'`** で待つ。 render 済みプロンプトは
    run 行に持ち、 起動入力一式は `queue_payload_json` に退避する。
  - **副作用 (worktree 作成 / prompt file 書き出し) は起動時まで遅延**する。 待たせている間に
    worktree だけ生えている中途半端な状態を作らないため。
  - 払い出しは **FIFO** (`created_at`、 同一 ms は挿入順)。 契機は ①子の完了報告
    (`POST /runs/:id/status` が terminal) ②20 秒ごとの定期 drain ③起動時 (再起動を跨いで
    queued のまま残った run を拾い直す)。
  - 適用範囲は **全 invoke 経路** (Discord 窓口 / Web UI / 朝スケジューラ / MCP)。
    `spawn:false` (render のみ) はキューを通らない。
- **スロットの数え方 (stale 扱い)**: 子が status を報告せずに死ぬと run は `running` のまま
  残る。 これをそのまま数えるとキューが二度と流れないので、 次の run は active から外す:
  - 子セッションが紐付いていて、 そのセッションが既に active でない
  - 紐付いた子セッションが無いまま TTL (既定 6h) を超えた

  外すのは **スロット計上のみ**で、 status は書き換えない。 「本当に失敗したのか報告を
  怠っただけか」 を Concordia は判別できず、 勝手に `failed` へ倒すと監査ログに嘘が残るため。
- **run は完了しても消さない**。 `delegation_runs` は purge 対象外 (セッションは `purgeStale`
  で消えるが、 外注の履歴 = 誰に何をいつ委託したか は残す)。 Web UI は 進行中 / 完了・履歴 を
  分けて表示する。
- 任意 (将来): `POST /v1/delegation/invoke-batch { items: [...] }`。

## 7. 子エージェントへの instruction (persona-context 追記)

委託 context (`src/delegation/persona-context.ts`) に:
- 「作業が **完了 / 失敗したら必ず** `POST /v1/delegation/runs/:id/status` を呼ぶ」
  (run id は spawn env `CONCORDIA_DELEGATION_RUN_ID` で渡す)。
- 「承認が要るときは Discord でなく **親へ** 要求する」(status/inject 経由)。
- 「追加 inject を受けたら継続する」。
- 併せて既存の「終わったらコミットする」(#279) と整合させる。

## 8. 実装スコープ (別セッション)

1. schema: `delegation_runs` に parent/child_session_id 追加 + migration。
2. child register で `delegation_run_id` → `child_session_id` claim。
3. `POST /runs/:id/status` / `POST /runs/:id/inject` / `GET /runs?parent_session=` 実装。
4. 親通知 + Cc inject の Discord ミラー投稿 (egress 経路)。
5. invoke `overrides` (model/provider/effort)。
6. spawn env に run id / parent。
7. persona-context 追記。
8. delegation spawn の Discord channel 生成抑止 (外注のみ)。
9. テスト (status/inject/link の純関数 + API) + spec-index。

## 未解決 (実装前に最終確認)

- 「GPT54」の正確な model id。
- Cc inject ミラーの投稿トーン/整形 (システムメッセージ体裁)。
