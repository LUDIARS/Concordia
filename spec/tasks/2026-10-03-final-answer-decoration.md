---
task: 2026-10-03-final-answer-decoration
project: Concordia
kind: 実装
created: 2026-10-03
---
# 最終回答のCc生成見出しを除去する

Actio `ad04b269-483c-403e-8e8b-ae9f482cf621` の独立可能な一部。
人間の「頭につける表記消す」に従う。UX-CC-W4/S5、SPEC-SESSION-CHAT-RESPONSE-WORK。
chat-platforms (支援) がDiscord整形を所有し、egress.ts/egress.test.tsは既存membershipと
cc.acceptance対応・Augur登録に所属する。本文保存/完了判定の状態所有者は変更しない。

Cc付与のUnicode FINAL ANSWER見出しだけを除去し、原文に同語があっても削除しない。
summary/final_answer/commentary、添付fallback/改行を維持する。
thinking/task/tool整形、配送台帳、完了通知、メンション制御には変更を加えない。
進行表示・実開始秒時刻・turn状態は今回未実装の残件。#2329やLi時刻契約に依存しない変更とする。

復旧は整形差分のrevert。DB migration/保存本文や過去Discord投稿の書換えは不要。
検証は親claim下でmock egress/直接回帰とbackend型を実行する許可を受けた。
サービスbuild/restart・実Discord投稿・本番DB/APIは実施しない。新しいruntime observe契約を
追加/実測したとは主張せず、既存イベント配送を通す回帰で受入を確認する。

## 検証記録 (2026-10-03)

base local main75f952da、専用branch fix/final-answer-decoration-20261003。
親testing claim下でegress24件・relay-output-filter4件・channel-work-state8件、
計3files36/36合格 (12.19秒、TEMP/cc-final-heading-tests.log)。最初の実行で全合格、再実行は不要。
AI本文のASCII/Unicode同語・先頭見出し・改行を原文維持し、添付fallbackを確認。
create/updateのturnEnd callback、同一配送のsend/callback重複防止、delivery ID、
allowedMentions、既存thinking/task/toolの整形・final-only filterを同じ境界で確認した。
backend tsc --noEmit合格、diff check合格。
test tscは既存2件のProviderName型エラーで未合格。
src/api/sessions/startup-policy-check.test.ts:50、tests/usage-budget-spawn.test.ts:27の
`claude`値が原因で、両ファイルはbase75f952daとの差分無しを確認した。今回の範囲では変更しない。
relay-output-filter.tsの旧装飾説明は最終発言の意味判定だけに修正した（コメントのみ、追加実行無し）。
cc.acceptanceの既存egress.ts→egress.test.ts対応とAugur正規登録t-62d1f506e291(active)を照合、lint valid。
既存登録・契約台帳に不足は無く重複登録を足さない。観測契約の新規実測はしていない。
実サービス・実Discord・保存済み過去投稿の反映確認は未実施。親が提出/merge/実反映を担当する。
実開始時刻付き作業中表示の残件は元Actioで保持し、この部分の保存をtask全完了とは扱わない。
