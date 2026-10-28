# 学習日記と連合調査の境界修正 (draft)

Actio: `actio:262ba08f-20e5-4125-b2d5-4047a386c060` の最新の High 2件のみ。

## 契約

C-1 journalText(value): 外部文字列をHTMLとMarkdownの構文として出力しない
C-2 inquiryClaudeArgs(model, settings): 道具をRead/Grep/Globに限定し実行時の読取ガードを必須にする

## 境界と再利用

- governance: 学習 run/会話が正本、日記は写し。既存の renderLearningJournal と同期を維持し、表示変換だけ分離する (PATROL-JOURNAL-INV-01)。
- federation: 実行側が作業ルートを所有し、既存 runner とキューを維持する (SPEC-FED-INQUIRY-READ、CC-INV-02、UX-CC-W1/S1)。
- harness/inquiry-readonly は director 問診の case API 権限に結合し、字句パスだけを検査するため流用しない。
- tools/command-tools/storage の実経路・通常ファイル検査の考え方を採用し、registry専用I/Oは依存させない。

## 検証計画と制約

augur plan は情報不足として既存動作の特性化を提案した。指摘のソースと境界から以下に具体化した。
既存の日記・実行キューのテストを維持し、HTML/Markdown・全外部フィールド・範囲外パス・junction・
hardlink・不明ツール・CLI引数・ガード設定の回帰を追加する。
ユーザーの明示に従いテスト・サービス・実メッセージ送信は未実行。契約の実行証跡も未取得。

## 復旧と未確認

日記は既存同期の対象日を次の通常passで置換する。古い対象外の日記は自動修復しない。
連合調査は許可ルート・ガード配備の修復後に再依頼する。安全ガードを外すロールバックは推奨しない。
実機のCLIフック動作とOSの検査後差替え競合は未検証。Revisor提出とマージ・稼働反映は別の状態として報告する。
