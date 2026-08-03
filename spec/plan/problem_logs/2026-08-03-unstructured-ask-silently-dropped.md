# 未構造化 ask マーカーが transcript relay で無言破棄される

- Date: 2026-08-03
- Status: fixed in working tree
- Area: transcript relay / Discord egress / Lictor boundary
- Severity: high — 質問カード化に失敗するとユーザ判断要求が完全に見えなくなる

## Summary

Lictorで構造化されなかった生の `ask` マーカーを、Concordiaが質問カードの別送を確認せず
transcript本文から除去していた。askだけのメッセージは空文字になり、relay対象から外れるため、
質問カードも本文もDiscordへ届かなかった。

## Evidence

- Lictor側ではCodexの `SkillInjector` が作られず、askマーカー検出も同時に無効化されていた。
- `src/platform/egress-filters.ts` の `stripAskMarkerBlocks()` は生のaskブロックを無条件除去した。
- `src/platform/transcript-relay.ts` は除去後が空なら `null` を返し、中継を停止した。
- 実セッションで正常なask JSONを2回出力しても、質問カードも代替本文も表示されなかった。

## Cause

Concordia側が「rawマーカーが届いた時点でLictorによる構造化と質問カード投稿が成功済み」と
仮定していた。しかし正常系ではLictorがrawマーカー自体を消費するため、Concordiaへrawが
届くことは構造化失敗を示す。成功確認なしの除去により、境界障害がsilent failureになった。

## Fix

- raw askマーカーを除去する処理を廃止した。
- raw askを検出した場合は警告と元本文を通常メッセージとして返す
  `renderUnstructuredAskFallback()` を追加した。
- パーサ責務はLictorへ一元化し、ConcordiaではJSONを再解釈しない。
- askだけ、散文付き、複数ask、transcript relay経由の回帰テストを追加した。
- Lictor/Concordia間の責務とfail-loud不変条件を仕様へ明記した。

## Verification

初回実装時はユーザ方針に従って手動テストを実行せず、明示許可後にRevisorの登録済み
テストを実行した。

Revisor初回審査では、`src/slack/render.test.ts` の旧仕様を期待する2テストが失敗し、
追跡済み `.anatomia/domains` にchat-platforms定義が無いため対象ドメインも未判定になった。
Slackの期待値をfail-loud契約へ更新し、chat-platforms membershipと明示的なspec linkageを
追加した。修正後のRevisor再審査結果は未確定である。
