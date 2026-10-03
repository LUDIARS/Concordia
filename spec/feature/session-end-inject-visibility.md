---
id: SPEC-SESSION-END-INJECT-VISIBILITY
type: feature
domain: session-message-layer
status: implemented
---

# 内部の終了指示をチャットへ投稿しない

2026-10-03 neco の「/session-endとか投稿しないように」に基づく。
Actio: actio:908fc672-8587-4e9e-b943-9e6682d6af42。
問題記録: main checkout の spec/plan/problem_logs/2026-10-03-session-end-inject-chat-mirror.md
（本worktreeへ複製・stageしない）。UX-CC-W4 / UX-CC-S5。

session-message-layer は利用者向け表示の判断を所有し、chat-platforms のDiscord adapterが
同じ小さな純関数を使う。判定は正規source `auto:session-end` の完全一致だけ。
本文、時刻、provider、部署設定、人間の発言から終了指示を推測しない。
Discord mirrorはnull、canonical projectorは空配列を返す。
他domainの状態やEventBusを変更せず、WSへの実行配送、ログ保存、監査、終了処理を維持する。
sessionEndOutputEnabledは実行injectも止めるためこの修正には使用しない。

受入 SEI-VIS-01: `/session-end` / `$session-end` / 自然言語終了指示を正規sourceで非表示。
SEI-VIS-02: 同じ本文の人間入力・引用・未知source・似たsourceを消さない。
SEI-VIS-03: canonical row/通知は増えず、元EventBusの終了指示は観測できる。
SEI-VIS-04: assistant完了報告・question・permission・既存plan通知は維持する。
CC-INV-02/03は実行認可と再送判断を変更しないという境界、CC-INV-06は表示と配送を
混同しない境界、CC-INV-08は人間待ちや回答経路を触らない境界として参照する。

既存履歴の削除/migrationは行わず、新しい投影から適用する。raw transcriptのechoを
本文一致で消さない。正規provenanceの無いechoは引き続き表示する。
Slackは既存のauto inject非転記を維持する。rollbackは表示policyと2呼出点を戻すだけで
実行や永続DBスキーマの変更を伴わない。

テスト実行は人間が許可し、親がtesting claimを所有する。サービス/build/restartは禁止。
単体・canonical memory DB・既存終了制御回帰を記録する。実機表示/WS/provider検証は未実施。
plan承認の新規通知は本変更の対象外。Lictorからkind/providerRequestIDを運ぶ別作業が残る。
そのためActio全体の完了を主張しない。

## 検証checkpoint (2026-10-03)

変更3sourceに一致するcc.acceptance全行のtests和集合4filesと、既存終了制御2filesを実行。
`src/messages/service.test.ts` 13、`project.test.ts` 33、Discord mirror31、
shared policy9、auto-session-end7、end-session-command4、計6files97/97合格 (8.90秒)。
serviceの追加fixtureを不完全型から正規codex-cli/全必須fieldsへ修正し13/13を再確認 (5.11秒)。
EventBusを通した本物の終了injectは観測され、canonical row/summaryは増えず、
後続のweb人間入力は同じ終了文字列でも保存・通知される。question/permission/final_answerも保持。
これは既存イベント投影と通知の保護であり、新規provider plan承認bridgeの動作確認ではない。

Backend `tsc --noEmit -p tsconfig.json` 合格。test tscは既存未変更2件のみ:
`src/api/sessions/startup-policy-check.test.ts:50` と `tests/usage-budget-spawn.test.ts:27` の
claude/ProviderName不一致。両ファイルはbase a2e6b63bとの差分が空で、本件では直さない。
Augur正規CLIでpolicy testと既存未登録mirror testの2件を登録、project/service既存登録を照合、
lint valid。SEI-VIS-01のobserve定義は共有policyに登録。SEI-VIS-02〜04はspec受入シナリオで、
独立runtime契約を実測したとは主張しない。predicateの正負unit検証はpolicy9件内で実施。
diff check合格。既存sourceのmetadata/provenanceやroutes middlewareへ旧PR修正を混ぜていない。

2026-10-03: checkpoint 3579d32eをlocal main e9c52b5dへrebase。
契約台帳の既存50定義と受入台帳の既存482行を内容・順序とも保持し、今回の1定義/3行を追記。
Augur正規登録の今回2件も保持。統合後の同じ6files97/97を1回再実施し合格 (7.58秒)。
統合後のbackend `tsc --noEmit -p tsconfig.json` も合格。

サービスbuild/restart/実provider/実機Discord/WebUI/Slack画面確認はこの子では未実施。
main問題ログは読取参照だけで編集/stageしていない。新規DB migrationや履歴削除は無い。
plan承認ダイアログの新規通知は別途Lictor kind/providerRequestIDが必要で残件。
Actio全体の完了、稼働反映や人間UX評価の完了を宣言しない。
