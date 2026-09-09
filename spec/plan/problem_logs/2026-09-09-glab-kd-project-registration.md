# GLab の作業候補に KD が出ない

- Date: 2026-09-09
- Status: configuration corrected; Discord UI not verified
- Area: GLab subsidiary project scope
- Related: UX-CC-W1 / CC-INV-01 / CC-INV-04

## Summary / Evidence

ユーザーが KD を GLab のプロジェクトへ登録するよう依頼したが、担当 agent は
GLab チームの repos に origin URL を追加しただけで完了と報告した。
その後「KD が作業リストに出ない」と報告された。
KD の project code registry 上の project 名は KonbiniDominant。本社 GLab チームと
GLab 子会社は別の設定であり、子会社の projects は修正前 3 件だった。

## Cause / Regression Context

登録先の取り違えによる作業漏れ。既存機能のコードデグレではない。
`src/discord/bot.ts` の `projectChoices` は `subsidiary.resolveProjects()` を参照し、
`src/subsidiary/manager.ts` はその都度 `subsidiaryRepo.listProjects(id)` で読む。
チーム repos への追加は子会社 projects に伝播しない。

## Fix / Verification

GLab 子会社の PATCH /v1/subsidiaries/:id に既存 3 件を保持した projects を送り、
KonbiniDominant を追加した。PATCH 応答と query parameter を変えた GET では 4 件を確認した。
一方、更新直後の同一 URL GET は古い 3 件を返しており、この一時的不整合の原因は未調査である。
Bot は新しい質問カードを作るたびに DB から候補を読むため、手動のプロセス再起動は不要。
既に投稿済みの選択カードは静的な選択肢なので自動更新を保証しない。
Discord の表示自体、起動・単体・統合テストは未確認・未実行。

## Follow-up

登録完了の判断ではユーザーの操作面が参照する設定を照合する。
既存のチーム登録は削除していない。未依頼のプロジェクトの公開範囲変更はしない。
