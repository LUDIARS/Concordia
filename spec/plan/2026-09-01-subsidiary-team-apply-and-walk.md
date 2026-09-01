# 子会社チーム適用 + チーム簡素化 + 散歩セッション + パートタイマー退勤 (2026-09-01)

> 2026-09-01 neco 指示。
> 前提: PR #1138 (子会社 taskflow スコープ、マージ済) / PR #1167 (子会社のチーム所有 +
> Discord gateway 共有、審査通過) の上に積む。

## 指示の分解と実装

| # | 指示 | 実装 |
|---|---|---|
| 1 | フォーラム投稿でセッション spawn を子会社でも | Session forum の spawn-by-post は guild 共通配線 (`forum-spawn.ts`)。子会社はスレッド本文を Sonnet ガード (`guardSubsidiaryForumSpawn` — ロック/予算/監査込み) に通してから起動 |
| 2 | spawn 権限の無いメンバーの投稿は管理者以上が押して効果のある許可ボタン | `forum-spawn-approval.ts`: スレッド内の承認カード。押下は社員名簿 `session_spawn` (管理職以上) のみ有効、申請者本人不可、1h 失効。許可で `executeForumSpawn` に再入 (triggered_by 冪等) |
| 3 | チームはチーム内で spawn するだけに簡素化 | teams fanout cron 4 本 (朝礼/定例/課題スカウト/タスク整理) を削除、Director 巡回 (自動実装起動・問診) を bootstrap から外す。spec: teams.md §0.5 / director-patrol.md (superseded) |
| 4 | 巡回でディレクターがつぶやくやつ (散歩セッション) だけ適用 | curiosity-walk を実装: `walk-{scheduler,materials,runtime}.ts` + `curiosity_walks` (migration 79) + テンプレ `claude-sonnet-5-walk`。稼働中の全チーム (本社+子会社所有) からランダムに 1 つ引き、素材 A をチーム repo へ寄せる。投稿は本社「ぼやき」1 本。workflow key `curiosity` (既定 ON) |
| 5 | 子会社 Discord を読む処理 (チーム有無と無関係、本社からの指示でも可) | `subsidiary/discord-read.ts` (REST 読み取り専用) + `GET /v1/subsidiaries/:id/discord/channels` / `.../:channelId/messages`。loopback なので本社セッションからも叩ける。クロス guild 読み出しは 403 |
| 6 | パートタイマーは仕事が終わったら退勤 (セッション終了+ターミナルを閉じる、判断不要) | 一次: parttimer 共通完了ステップに Lictor `POST /v1/shutdown` の退勤を追記 (seed.ts)。安全網: `control/parttimer-clockout.ts` が run 終局後も残留する子セッションを 90 秒猶予で DELETE /v1/sessions (プロセスツリー kill = ターミナルも閉じる) |

## 主要変更ファイル

- discord: `forum-spawn.ts` (権限チェック分離 + ガード hook), `forum-spawn-approval.ts` (新規),
  `bot.ts` (deps 共有化 + 承認再入口), `commands.ts` / `command-port.ts` (ボタン dispatch)
- subsidiary: `gate.ts` (評価フェーズ抽出 `evaluateSubsidiaryRequest` + forum 用入口),
  `manager.ts` (`guardFor`), `discord-read.ts` (新規), `api/subsidiary.ts` (/discord/* 追加)
- director: `walk-scheduler.ts` / `walk-materials.ts` / `walk-runtime.ts` (新規),
  `workflow/curiosity-binding.ts` (新規), `db/walks-repo.ts` + migration 79
- scheduler: `cron-jobs.ts` (teams fanout 4 本削除)
- control: `parttimer-clockout.ts` (新規)。 delegation: `seed.ts` (退勤ステップ + walk テンプレ)
- bootstrap/core.ts: patrol binding → curiosity binding、clockout 起動、discord-read 配線

## 残 (このブランチ外)

- PR #1167 のマージ (人間のマージボタン。 本ブランチは #1167 に stack しており、
  提出前に #1167 が main へ入っていることが前提)
- curiosity-walk §4 反応重み学習 / §5 コスト面 (walk_id 記録済み、未実装)
- Slack 子会社の forum spawn (Discord のみ)
