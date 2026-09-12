---
type: feature
title: 危険なpushのWARNING承認特例
id: CC-PUSH-WARNING
service: concordia
domain: governance
status: draft
---
# 危険なpushのWARNING承認特例

## 価値とシナリオ
UX-CC-W1/W4、UX-CC-S1/S5。通常のRevisor公開ではできない履歴修正を人間が認可する。
現時点の対象はRevisor workflowのGit pre-push。任意のshellコマンド、Castra本体、未知のworkflow、起動やテストの制限を解除する仕組みではない。

## 業務用語と状態所有者
「操作票」はGit pre-pushの送信先・全refの新旧SHAとCcのsession/repo/branchを束ねたもの。
Ccが操作票と判断の監査をsession_eventsに保存する。承認は当該HTTP呼出しへの一回の応答のみで、再利用可能なgrantや承認APIは設けない。
同時表示はCcプロセスにつき一つ。並行要求は拒否し、人間の画面を埋めない。

## 不変条件
- CC-PW-01: 登録済みactive session・実checkout・origin・workspace境界を検証できたRevisor pushだけが対象。Castra本体と不明な対象は例外不可。
- CC-PW-02: WindowsデスクトップにCc自身がWARNINGを表示する。対象、session、branch、送信先、refの新旧SHA、履歴やタグを置換し得る影響を示す。理解確認チェックと「今回だけ許可」を必要とし、Enter/Esc/閉じる操作の既定は拒否。
- CC-PW-03: 通常のquestion/permission-response API、AIの返答、環境変数で承認できない。AIはダイアログを操作して自己承認しない。これはOSのsecure desktopや同一ユーザー権限の悪意あるプロセスへの防御を提供するものではない。
- CC-PW-04: 90秒の時間切れ、表示不可、プロセス異常、Cc停止は拒否。承認後もsessionとcheckout/workflowを再確認する。
- CC-PW-05: Git既存フックをそのまま実行する。Ccの承認はRevisor自身やリモートのbranch protectionを解除しない。force-with-lease等のGit側の競合検査は呼出し側の責務。dry-runでも承認を消費し、次回は再確認する。

## 実装境界
tools/session-git-hook.mjsはGitの実際のpre-push入力をHTTPへ渡す。
src/control/push-warning.tsは操作票の検証と表示文を定義する。
src/control/push-warning-dialog.tsとtools/push-warning.ps1はWindows UI adapter。
src/api/session-push-check.tsが既存の認可、監査、ダイアログ、再検証を順序づける。

## 復旧と検証
応答不明時はpush結果をGitで照合し、自動で再pushしない。承認は永続化せず再起動後は再確認する。
非Windows/非対話デスクトップでは未対応として拒否し、認証を伴う遠隔承認は別途設計する。
拒否/承認/時間切れ/入力改変/並行要求/binding変更の契約テストを追加する。実行および実画面での検証は許可後に本体フォルダから行う。

## 調査根拠
基点2645f011。既存push-checkはcwdのみを受け付けRevisor workflowを無条件拒否していた。
Pf Concordia (01M1XZZMEXWTFCN4HKW8K7TJKM) のUX本文は未登録、版0。repoのUX-CC-PRODUCTを参照した。
Anatomia project concordiaのplan照合と現行ソースを使用。通常の質問APIは委託AIからも回答可能なため認可には再利用しない。
