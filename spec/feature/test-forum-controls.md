---
type: feature
title: "テストフォーラムの操作面 — テスト開始 / マージ"
description: "Revisor が Open / Test OK にした PR の Discord テストフォーラム投稿に、テスト開始ボタン・provider(model)/effort セレクト・マージボタンを載せる。テスト開始で専用セッションを起動して投稿と Lictor で同期し、同じボタンがマージへ変わる。閾値以下はオートマージ、/co-combine で他 PR と連動。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - forum
  - session-spawn
  - merge-gate
  - state-machine
status: active
related:
  - ./revisor-test-forum-sync.md
  - ./revisor-local-pr-submission.md
  - ./staff-roster.md
updated: 2026-08-07
---

# テストフォーラムの操作面 — テスト開始 / マージ

## 1. 背景

`revisor-test-forum-sync` は Revisor に登録された open な local PR を Discord の
テストフォーラムへスレッドとして掲載する (審査前・失敗・判断待ちも含む)。
操作面を出すのは、そのうち **Test OK になった候補だけ**。
しかし掲載されるのは**テキストだけ**で、
そこからテストを始める手段もマージする手段も無く、 人間が別途 Revisor UI や CLI に
移動する必要があった (neco 指摘 2026-07-31)。

## 2. 状態遷移 (実装済み: `src/discord/test-forum-controls.ts`)

```
candidate ──[テスト開始]──> starting ──[session.started]──> testing ──[マージ]──> merged
```

| 状態 | 出す操作 |
| --- | --- |
| `candidate` | 「テスト開始」ボタン + provider(model) / effort セレクト |
| `starting` | 操作を隠し、セッション登録を待つ。スレッド投稿からも再起動しない |
| `testing` | **同じ場所が「マージ」ボタンに変わる**。 セレクトは畳む (起動済みセッションの設定は変えられないため) |
| `merged` | 操作を出さない (二重マージの入口を残さない) |

- 既定は **codex Sol / effort xhigh** (neco 指定)。 確認は見落とさないことが価値なので
  既定を最強に置き、 軽く回したいときだけ下げる
- `customId` は `test:<action>:<surfaceId>` の 1 書式に集約 (送信側と受信側でずれない)。
  既存のコントロールパネル (`ctrl:`) とは名前空間を分ける
- 未知の provider / effort は既定へ落とす — 不正値が spawn 引数へ渡らないようにする
- effort の選択肢は provider ごとに絞る。 Claude Code の effort 語彙に `minimal` は無い
  (`control/provider-preset.ts`) ため、 選ばせて spawn 時に黙って捨てさせない。 provider を
  切り替えて現在の effort が無効になる場合は、 その provider の既定へ寄せる
- spawn へ渡す effort のキーは provider レーンに合わせる (claude は `effort`、
  codex 系は `model_reasoning_effort`)。 取り違えると選択が無言で捨てられる

## 3. 永続化 (実装済み: migration 49 + 50)

`discord_test_surfaces` に以下を追加:

| 列 | migration | 意味 |
| --- | --- | --- |
| `run_state` | 49 | `candidate` / `starting` / `testing` / `merged` |
| `provider` / `model` / `effort` | 49 | 「テスト開始」前にセレクトで変えられる実行設定 |
| `session_id` | 49 | 起動した確認セッション |
| `local_pr_id` | 49 | マージ対象の Revisor local PR |
| `controls_message_id` | 49 | 操作面を描いているメッセージ (押下のたびに更新する) |
| `repo_root_path` / `head_branch` | 50 | Revisor 登録値だけを焼いた spawn target (§6) |

## 4. 実装範囲

1. **描画**: `test-forum-discord.ts` がボタン / セレクトを構築し、押下後も同じメッセージを更新
2. **受信配線**: `commands.ts` の interaction dispatch が `test:` を処理
3. **テスト開始**: 選択された provider/model/effort で、設定済み workspace root を cwd
   として確認セッションを spawn し、スレッドへ束ねて Lictor 同期させる。Revisor に
   登録された repository/worktree と local PR の head ref は起動プロンプトで後から
   指示し、セッションにフォーラム投稿を読むよう明記する。個別 repo を spawn cwd にせず、
   `branch + worktree=true` も渡さない。
   起動要求前に surface を原子的に `starting` へ進め、`session.started` で `session_id` を
   結び `testing` へ進める。この間の同じスレッドへの投稿は新規 spawn せず待機する。
   `session_id` 確定後の投稿は既存 session へ inject する。
   Test Forum session に限り Cc が暗号化設定から都度解決した Revisor workflow token を
   `CONCORDIA_REVISOR_WORKFLOW_TOKEN` として spawn 環境へ委譲する。値は API 応答・prompt・
   ログへ出さず、Revisor の変更系 API の Bearer token としてだけ使う。token が無ければ
   使用不能な session を起動せず fail-fast する。
4. **マージ**: 管理職以上に限定し、Revisor の `POST /v1/local-prs/:id/merge` を叩く。成功で `merged` へ遷移
5. **オートマージ**: Revisor 側に `autoMergeIfEligible` + `autoMergeRiskThreshold` が既に
   あるので、 Concordia 側の実装は不要。 `autoMergeEnabled` を有効化する運用判断のみ

`/co-combine` による複数 PR の連動は単一 PR の操作面とは別責務のため、後続機能として扱う。

## 5. 権限

テスト開始とマージはいずれもホスト側に副作用を起こすため、社員名簿
(`spec/feature/staff-roster.md`) の **管理職以上**に限定する。判定は操作ごとに別の
capabilityで引く — テスト開始は `session_spawn`、マージは `merge_pr`。最低役職は現状
どちらも管理職だが、`CAPABILITY_MIN_ROLE` を動かしたときに片方だけずれないようにする。
権限checkが未配線ならfail-closedとし、セレクト変更だけではsessionを起動しない。
provider/effortセレクトの変更もそのまま特権spawnの引数になるため、テスト開始と同じ
`session_spawn` で守る。権限の無いメンバがマージ直前の実行設定を差し替えられないようにする。

## 6. 確認対象の解決境界

候補選別の正本は `/v1/local-prs` の open 行だが、spawn targetまでは1本では揃わない。
Concordiaの Revisor read clientは同じloopback APIの `/v1/local-prs` と `/v1/repositories`
を併読し、`repository` で次を結合する。

- local PRの `headRef`
- Revisorへ登録済みrepositoryの `rootPath`

この2値を `discord_test_surfaces.head_branch / repo_root_path` に固定し、テスト開始時に
Concordiaの既存spawn-targetへ渡す。任意のDiscord入力やmain checkoutからpath・branchを
推測しない。解決不能・不整合・権限check未配線は開始前にfail-closedする。

作成・再利用された実worktree pathは `session.started` 時にsurfaceへ記録する。そこで
起動するのは確認担当のAIセッションであり、サービスの再起動・起動テストは別途
Excubitor claimとプロジェクト本体フォルダの運用制約に従う。
