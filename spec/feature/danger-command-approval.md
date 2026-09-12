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
同じsessionの並行要求は拒否する。Discord Bot runtimeが自分のscopeの依頼だけを受け付け、候補が複数ある場合も拒否する。

## 不変条件
- CC-PW-01: 登録済みactive session・実checkout・origin・workspace境界を検証できたRevisor pushだけが対象。Castra本体と不明な対象は例外不可。
- CC-PW-02: Discordの対象sessionスレッドにWARNINGカードとUTF-8添付全文を送る。対象、session、branch、送信先、全refの新旧SHA、履歴やタグを置換し得る影響を示す。「全refを確認し、今回だけ許可」ボタンを明示的に押す。
- CC-PW-03: 通常のquestion/permission-response API、AIの返答、環境変数で承認できない。AIはダイアログを操作して自己承認しない。これはOSのsecure desktopや同一ユーザー権限の悪意あるプロセスへの防御を提供するものではない。
- CC-PW-04: 10分の時間切れ、配送不可、プロセス異常、Bot/Cc停止は拒否。承認後もsessionとcheckout/workflowを再確認する。hook待受上限は11分。配送要求が遅延しても期限を延長しない。
- CC-PW-05: Git既存フックをそのまま実行する。Ccの承認はRevisor自身やリモートのbranch protectionを解除しない。force-with-lease等のGit側の競合検査は呼出し側の責務。dry-runでも承認を消費し、次回は再確認する。

## 実装境界
tools/session-git-hook.mjsはGitの実際のpre-push入力をHTTPへ渡す。
src/control/push-warning.tsは操作票の検証と表示文を定義する。
src/control/push-warning-dispatch.tsは稼働Botのscopeを照合する。src/discord/push-warning.tsがカード配送とtrusted Gateway interactionを担当し、src/discord/bot.tsが開始・終了とイベント配送を所有する。通常のanswer-question/permission-responseからは承認できない。
src/platform/push-warning.tsは共有型契約のみを定義し、src/bootstrap/core.tsが登録・文面生成・指示者解決をcallbackで注入する。Discordからcontrolへの直接依存は禁止し、依存検査の例外は追加しない。
承認者はCcの直近の人間injectから解決したDiscord指示者で、既存の執行役員向けisKillSwitchUserAllowed認可も満たす必要がある。本人・message/channel・期限・現在の所属/権限を押下時に再確認する。配送message IDと回答user IDを監査へ残す。
旧Windows adapterは既定経路から外し、Discord停止時のfallbackには使わない。
src/api/session-push-check.tsが既存の認可、監査、ダイアログ、再検証を順序づける。

## 復旧と検証
応答不明時はpush結果をGitで照合し、自動で再pushしない。承認は永続化せず再起動後は再確認する。
embedded Discord Botとbackendが同一プロセスで稼働する構成が対象。standalone chat-worker構成でbackendにBotが登録されない場合はunavailableとして拒否する。
拒否/承認/時間切れ/入力改変/並行要求/binding変更の契約テストを追加する。実行および実画面での検証は許可後に本体フォルダから行う。

## 調査根拠
基点2645f011。既存push-checkはcwdのみを受け付けRevisor workflowを無条件拒否していた。
Pf Concordia (01M1XZZMEXWTFCN4HKW8K7TJKM) のUX本文は未登録、版0。repoのUX-CC-PRODUCTを参照した。
Anatomia project concordiaのplan照合と現行ソースを使用。通常の質問APIは委託AIからも回答可能なため認可には再利用しない。
