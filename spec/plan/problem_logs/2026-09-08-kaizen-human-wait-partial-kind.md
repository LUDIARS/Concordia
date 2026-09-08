# カイゼンの人間判断待ち報告にwait種別が欠けていた

- Date: 2026-09-08
- Area: delegation-parttimer-inject
- Severity: 判断待ちを実装残として再起動する可能性

## Evidence
PR #1475/1478の反映確認で、KAIZEN_DAILY_PROMPTは判断待ちをpartialとして報告すると
指示していたが、remaining.kindを指定していなかった。
src/api/delegation.tsのisWaitRemainingはkind=waitかRevisor待ち文言のみを除外する。
そのため通常の「人間判断待ち」はworkRemainingに入り、再委託され得る。
実際の人間待ちrunを増やす再現は行わず、API契約とプロンプトを照合して検出した。

## Cause and Fix
共通のpartial例をそのまま使えると扱った契約漏れ。
人間判断待ちはkind=waitを明示する指示と、そのまま使えるstatus JSON例を追加する。
タスク保存・DBのpending・共通退勤手順は維持する。

## Verification
カイゼンの実プロンプトに記載したJSON例をAPIへ渡し、新規invokeがなくrunが閉じることを
一時DBと偽の委託サービスで検証する。外部へのAI実装委託は発生させない。
