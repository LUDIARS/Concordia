# Discord Forum の「作業中」投稿がチャンネルを浮上させる

- Date: 2026-07-18
- Status: fixed
- Area: Concordia / Discord Forum session lifecycle
- Severity: UX noise

## Summary

Discord sessionの進捗ごとに「🔄 作業中…」を削除・再投稿するため、実質的な回答がなくても
Forum投稿がチャンネル一覧の上部へ浮上し、通知・閲覧上のノイズになっていた。

## Evidence

`src/discord/bot.ts` がDiscordにもplatform共通の `WorkingIndicator` を生成し、
`transcript.frame`、session-scoped `chat.posted`、promptのたびに `noteProgress()` を呼んでいた。
`WorkingIndicator` は進捗後に `channel.send("🔄 **作業中…**")` を再実行する設計だった。

## Regression Context

Forum移行後も、通常テキストチャンネル向けの末尾メッセージ方式を残したため、Forumの
状態タグと「作業中」投稿が重複していた。

## Cause

DiscordとSlackで同じ投稿型indicatorを共有し、Forumが持つ状態タグを唯一の作業状態表示に
切り替えていなかった。またタグ側は完了frameではなく10分無進捗タイマーで解除していた。

## Fix Requirements

- Discordでは「作業中」メッセージを投稿しない。
- promptまたはtranscript進捗でForumタグを `作業中` にする。
- `summary` / `final_answer` がDiscordへ正常に投稿された後でだけ `待機` に戻す。
- 投稿失敗時は `作業中` を維持する。
- Slackの投稿型indicatorは維持する。

## Verification

- completion frame判定の単体テスト。
- タグ状態の開始・完了・再開・非同期更新順序の単体テスト。
- egress成功時だけcompletion callbackが発火し、失敗時には発火しないテスト。

## Follow-up

実サービス確認を行う場合はExcubitor経由でConcordia testing claim/releaseを使う。
