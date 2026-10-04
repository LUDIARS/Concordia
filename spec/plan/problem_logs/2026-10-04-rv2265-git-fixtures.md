# #2265 再審査の Git fixture 失敗

- 対応指示: neco の Cc RvPR 全件逐次マージ。Actio `ec877263-c52b-4ecd-89f3-f2595c80a2b4`。
- 審査 HEAD: `cb27a09fc4c2bacd533df056e4103b5f901f4526`。
- 保存結果: harness-reliability `r-20261003231248709-8073cd94` の task-branch checkout 検証が STACK_TRACE_ERROR、persistence `r-20261003231248429-b59a36dd` の Conflux Git 検証が rev-parse の子プロセスエラー、tooling `r-20261003231248755-e856469e` の admin worktree 検証が後片付けの EPERM。
- 対象境界: 登録済みテストの disposable Git fixture のみ。本番 Git adapter、期限、業務判断、テストの検証条件は変更しない。
- 修正: task-branch と admin fixture に空のローカル hooksPath を設定。後片付けはイベントループを止めない非同期 rm と有界再試行に変更し、親ディレクトリも finally で処理する。削除失敗は隠さない。
- Conflux の子プロセス失敗は原因未確定。終了コード・signal・killed・stderr を再審査結果に残す診断を追加。検証を省略したり、失敗を成功へ変換しない。
- 復旧: この修正 commit を revert する。利用者の Git 設定、他者の worktree、サービス状態には変更を加えない。
- 検証: ローカルテストとサービス操作は未実施。静的差分確認後、通常の Revisor 再審査に提出する。
