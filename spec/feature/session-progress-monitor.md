---
title: セッション進捗モニター
id: CC-SESSION-PROGRESS-MONITOR
status: draft
domain: chat-platforms
related: [../ux/product.md, ../architecture/ddd.md, autonomous-work-continuation.md, goal-and-go.md]
---

# セッション進捗モニター

Actio: `actio:6f195c99-35a4-4548-a987-f172a59fbc01`。UX-CC-W2/W4/W5、CC-INV-02/03/04/06/08。
通常チャンネルと公開フォーラムスレッドで作業する担当を既存 concordia-monitor から辿る。
モニターは表示のみを所有し、進捗は担当、G&G と質問/人間待ちは既存 control が所有する。
既存10分進捗要求 PR #3620 (ebe1165b) は依存する別成果で、ここでは再実装しない。

担当は応答に次の独立した報告を含める。task は現在の current_task と完全一致、at は UTC ISO、
evidence は根拠、remaining は残件。complete は依頼全体の完了条件を満たした場合のみ true。
終端 delegation status は使用しない。報告から30分経過・対象不一致・不正値は未確認。
人間発言や tool 出力から抽出せず session_messages の assistant 行のみ参照する。

```cc-progress
{"task":"現在の作業名","percent":40,"evidence":"実装済み、審査未実施","remaining":["審査"],"complete":false,"at":"2026-11-06T00:00:00Z"}
```

組織別 read model に加え、表示先と元チャンネルの guild と閲覧権限を照合する。
公開範囲を証明できないチャンネル・private thread は一覧・コスト・件数から除外する。
元が全員閲覧可能、または表示先と同一 overwrite の時だけ表示する。本文中のmentionを無効化する。

配達キーは guild 固有 config の monitor_status_message_id と作成中状態。
作成前に sending を永続保存し、bot本人の固定マーカー付き投稿を最大100件照合する。
応答喪失・保存失敗・再起動後は既存投稿が見つかるまで新規作成しない。
編集失敗/削除/403/timeout も別投稿へ置換しない。運用者はDiscord履歴を確認してから
作成中状態と投稿IDを修復する。並行tickはchannel単位の単一flight、停止後の次tickで再照合する。
メッセージ上限を超える場合は1850文字以内のページへ分け、ページごとの固定投稿IDと作成中状態でeditする。
最大1000ページ。件数減少時は余った既存ページを「対象セッションなし」へ編集し、削除/再作成しない。
既存 monitor timer の既定を10分へ揃え、独立timerは追加しない。明示0は停止を維持する。

## 契約と検証計画

C-1 readMonitorProgress(text,task,now): 同一依頼の根拠付き報告だけを表示し未知・古い報告・未完100%を未確認にする
C-2 monitorDeliveryAction(state,found): 結果不明の作成は既存投稿の照合以外で再送しない

Augur plan の現状特性固定案を具体化し、進捗境界値/期限/別依頼、通常channel/forum、
組織・閲覧範囲、再起動/送信応答喪失/編集失敗/並行tickを対のテストにする。
テスト実行・サービス操作は禁止、静的/型確認のみ。契約実行証跡は未取得を成功としない。

## 過去要求との照合 (2026-11-06)

Pf登録project `01M1XZZMEXWTFCN4HKW8K7TJKM` をUTF-8で読取。
全196件を取得し、8/9 `01M4VTCSBMAEV9W43N96A61SMA` (idle/巡回10分)、
8/25 `01M4VTCSEBJFDJ2RDFSWNFGPBQ` (G&G既定ON)、8/27
`01M4VTCSEXYVEAWQB0MHP2A61T` (無反応抑止) の要約と旧版実装証拠も確認。
10/5 `01M4VTCSNSB8M5P5TB00Z6JARG` は無反応3回停止、10/8
`01M4VTCSQE686QTV187F0H7CV6` は実装中の例外、10/11
`01M4VTCSRFJFVTV7ME5PNK8DTM` は残件自動継続。implemented 表示は旧版
85097c81 の証拠で、現在の正本の11/4例外撤廃を上書きしない。
10/11は原文なしの遡及要約。検索不発を再提出が無かった証拠にしない。
今回の追加要求3ファイルと正規Actio本文で、旧成果にモニターが含まれないことを確認。
main 0e2766e1 の monitor-channel.ts は件数/コストのみ、編集失敗で再作成していた。
Anatomia 登録名 concordia を照合。UXの承認や実機評価は未実施。
