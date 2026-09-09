# 閉鎖済み質問の回答 API が 400 を返す

- Status: fixed in working tree; Revisor verification pending
- Area: Concordia #1631 / answer-question

Revisor の登録テストは 4673 件中 1 件失敗。
tests/sessions-discord-api.test.ts の「閉鎖済み質問への回答を 409 で拒否する」が
expected 409 / received 400 で失敗した。自動修正の commit は提出 branch に無い。
Revisor の一時 worktree は掃除済みで、生成されたテスト入力の全文は確認できていない。

現行 API は AnswerQuestionSchema を先に検証するため、閉鎖済みでも
古い・欠けた回答形式なら閉鎖チェックに到達せず 400 になる。
有効な question_id とセッション所有を確認できる閉鎖済み質問を先に 409 として返す。
未閉鎖の質問は従来の入力検証を維持する。別セッションの質問状態は返さない。

回帰ケースは有効な質問を作って明示閉鎖し、有効・欠落・不正 index をそれぞれ拒否し、
回答履歴が変更されないことを検査する。未閉鎖の不正入力は 400 のままとする。
ローカルのテストはユーザー方針により未実行。ビルド後に同じ PR を再提出する。
