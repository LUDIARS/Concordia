---
id: SPEC-CC-WORKPLACE
status: draft
---

# 職場チャットと相談の境界

2026-10-03 の人間の実装依頼（追加指示を含む）。対象は Concordia。
UX-CC-W1/W4/W6、CC-INV-02/03/06、CC-DEPT-INV-01 を維持する。

## 受入条件

1. 職場メニューからチャット一覧と既存セッションの内容を表示する。
2. 一覧はカテゴリで整理し、タスクワークフローは最初は閉じる。
3. 本社の職場では子会社のチャットも会社を識別して表示する。既存の認可を拡張しない。
4. 出力方針は会社が所有する部署ごとに設定する。本社総務は全表示、子会社総務は最終回答を既定とし、明示設定を優先する。人間の投稿と判断要求を失わない。
5. 相談にも Cc ハーネスを適用し、個人情報調査・秘密情報の操作をブロックする。違反は内容を通知へ複製せず管理者へ通知し、減点対象として記録する。減点量は本依頼で指定されていないため勝手に予算を引かない。
6. Cc inject は通常の人間の投稿と区別し、WebUI で既定閉のトグル表示にする。
7. Cc の実装指示は、対象が Pf に登録済みの場合、指示項目ごとにフラグメントへ記録する。登録のないプロジェクトは自動作成しない。再送で重複せず、結果不明を成功としない。
8. 人間と AI の発言を色とラベルで識別できるブロック UI にする。Astra がリデザインする。
9. 新規セッション起動成功時にダイアログを閉じ、失敗時は入力とエラーを保持する。
10. 新規セッションの会社・作業場所・部署を選択でき、サーバーの所属・起動制約に従う。
11. Markdown と表は専用レンダラで描画し、幅の広い表・コードはスクロールで読み取れる。生 HTML を実行しない。
12. プレイヤー投稿の転記エコーだけを非表示にし、別の同文投稿を失わない。
13. バグ報告・修正は Pf フラグメント登録から除外する。
14. Discord / Slack から人間がセッションへ送った指示は、task link の有無によらず届いた時点で Pf フラグメントへ記録する (2026-10-09 neco「全部入れる」)。短い返事も除外しない。非公開相談とバグ報告の除外、未登録プロジェクトを作らないこと、再送で重複しないことは 7・13 と同じ。

## 責務と復旧

### サイドカーの追加実装と検証境界（2026-10-03）

実装参照: `actio:edc5a681-4ff9-4c30-84ef-cb36dd3e7fb7`。タスク本文は Actio が所有する。
価値は UX-CC-W1/W4/W6、シナリオ S1/S5/S7、不変条件は CC-INV-02/03/06 と
CC-CONSULT-INV-03/05。新しい独立ドメインは作らない。

- session-coordination の既存 instruction-fragments を再利用し、項目単位のバグ除外と
  private_consultations の照会による Pf 除外を追加する。公開可否の照会 port が未接続なら送信しない。
- consultation の既存安全判定を質問・権限カードと transcript の構造化出力にも適用する。
  拒否出力は保存・投影の前に固定説明へ置換する。分類不能・所属不明は拒否し、減点候補にしない。
  任意のツール名を監査へ複製しない。監査の内容原本は増やさない。
- governance の部署方針を再利用し、thinking の実際の全体設定を表示へ渡す。
  bootstrap の canonical message 投影にも部署の会社識別を渡す。
- session-message-layer は本文・時刻一致によるエコー推定を廃止する。
  配送同一性のない投稿・旧推定印は表示を維持する。WebUI は検証済み同一性の印だけを非表示に使う。
  会話原本の削除や migration はない。復旧は変更の revert と表示設定の再設定による。

先行定義した契約（instrumentation・実測は未許可のため未実施）:

C-13 syncInstructionFragments(ports,input): 非公開相談は Pf へ送らない
C-14 instructionFragments(reference,title,body): 指示項目ごとにバグ報告・修正を除外する
C-15 safetyDecision(reason): 分類不能は拒否し減点候補にしない
C-16 consume(content,ts): 本文と時刻だけではエコーと判定しない

対応テストは cc.acceptance.json に記載。単体・統合テスト、build、サービス操作、UI 実機評価、
契約実測、Pf の実登録は実施していない。backend 型チェックは成功。
UI 型チェックで category 型漏れを修正したが、依存環境に react-markdown / remark-gfm がなく検証未完了。

未完了の境界（13 条件の全達成は主張しない）:

- 配送 ID を持たない現行 session.inject / Lictor transcript を結ぶ配送側契約。
  Cc だけで本文から推定すると同文別投稿が失われるため、未識別のエコーは残す。
- 直接 eventBus inject・provider 別 tool 実行など全経路の保護保証、非テキスト画像の内容検査、
  初回依頼者と違反監査の帰属、通知配送失敗の再照合。
- canonical message に種類がない status/context/report の個別表示制御。
- 別セッションへ持ち出された非公開由来タスクの公開可否と、Pf 結果不明時の実 API 照合。

これらの横断境界を推測して拡張せず、親へ残件として返す。許可された実装差分を commit し、
Revisor local PR を試行する。未実測を理由に機械ゲートが拒否した場合は回避しない。

`session-message-webui` は一覧・会話・入力の表示、`governance` は部署設定、
`consultation` は相談の保護、実装指示と Pf の連携は独立した adapter/application が持つ。
会話原本は session_messages、部署設定は departments、仕様フラグメントは Pf が所有する。
表示設定は会話原本を削除せず再設定で戻せる。外部登録は同じ指示の ID で照合する。

### 人間の指示 inject の記録 (2026-10-09)

7 は task link の登録時にだけ記録していたが、セッションが task link をほとんど登録せず、
Cc 由来のフラグメントは全 Pf プロジェクトで 0 件だった (Tirocinium の報告で判明)。
14 で、人間の inject を受けた時点の記録を足す。task link 経由の記録はそのまま残す。

- 入口は `POST /v1/sessions/:id/inject` (`src/api/sessions/relay.ts`)。人間の inject (source が
  `discord:<uid>…` / `slack:<uid>…` で発言者名あり) のときだけ記録する。制御 inject は対象外。
- 判断と参照の組み立ては `src/work/inject-instruction-fragments.ts`、配線は
  `src/api/sessions/inject-fragments.ts`。送信は既存の instruction-fragments (受入条件 7) を再利用する。
- 参照はセッション ID と source から作る。source にメッセージ ID がある経路は再送でも同じ参照になり、
  ID の無い経路は inject 時刻で区別する。
- inject の応答は待たせない。Pf / Anatomia の停止や結果不明はログに残し、inject は成功のまま返す。
- 復旧は変更の revert。Pf に記録済みのフラグメントは Pf 側の整理 (再構築) で扱う。

検証: `src/work/inject-instruction-fragments.test.ts` (登録・短い返事・非公開/バグ除外・再送の参照・
checkout 無し)。backend 型チェックで確認。実 Discord からの記録と Pf への実登録は反映後に確認する。

## 調査と検証

基点: Concordia ローカル main d13fe62d。Anatomia 登録名 concordia の context で関連実装を確認。
Pf 登録: 01M1XZZMEXWTFCN4HKW8K7TJKM（anatomiaRepo=concordia）。
既存仕様: departments.md、tech-consultation.md、session-message-webui-chat.md。
テストコードを変更と同時に追加し cc.acceptance.json へ対応を登録する。
テスト実行・起動・再起動の許可は別途の指示範囲に従い、未実施を実施済みと報告しない。

## 2026-10-03 サイドカー引継ぎ（未完了）

Actio 正本: `actio:8627c418-4ce8-407b-b79b-13ec08f4d7f3`。人間指示参照:
`human:2026-10-03:cc-workplace-chat-and-followups`。本書はタスク状態の正本ではない。
親は当初 Cc 委託を使わず backend を実装し、UI は組込み Astra 子へ依頼してしまった。
UI 子は編集を停止した。現在差分を checkpoint として Cc 正規 Sol sidecar へ渡す。
既存成果を再実装せず採否を確認し、不足分を完成させる。人間承認・テスト成功を推定しない。

### 現在の証拠

- backend `tsc --noEmit -p tsconfig.json` は成功。
- UI の `git diff --check` は成功。UI 型チェック、build、ブラウザ確認は未実施。
- 単体・統合・起動テストは一切未実行。明示の実行許可はない。
- react-markdown / remark-gfm を web package に追加済み。テストコードは追加途中。
- PR 未提出、配備なし、Pf への実フラグメント登録は未確認。

### 子で仕上げる範囲と判断の基準

1. DDD の所属と source/tests 対応を補完し、各変更境界の実効的なテストを書く。
2. HQ と子会社の表示範囲・会社ごとの部署・起動先・エラー保持を結合箇所まで確認する。
   `effective_output` の全体既定値（特に thinking）と実際の送信ポリシーを一致させる。
   canonical message で識別できない status/context/report の個別制御を完成としない。
3. 相談の保護は入口・tool・出力の既存経路を点検する。現在は relay と harness gate、
   Claude 相談 hook に接続しているが、QA・直接 inject・別形式出力の迂回を未確認。
   拒否時は機密を含まない説明を利用者へ返し、出力を黙って消さない。
   管理者通知の失敗を保存し、監査に本文・秘密・個人情報を複製しない。
   分類不能と違反を分け、減点候補だけ記録する。初回依頼の主体も辿れること。
4. Pf 連携は既登録対象のみ。task link の kind/title だけでなく項目単位のバグ除外と、
   非公開相談内容を輸出しない境界、再試行・結果不明の照合を点検する。
   現時点では公開 Pf API の sourceEventId を使い、信頼された cc 出典を偽装していない。
5. エコーは backend の内容・時刻 FIFO と marker の組合せ。未配達の inject 後の同文別投稿、
   再起動・重複転送も点検し、不確かな同文を消さない。過去の無印エコーは現状表示される。
6. UI は Astra の色分け・レイアウト案を維持し、型・接続・テストの不足を仕上げる。

テスト実行・起動・サービス再起動は追加許可なしに行わない。許可された起動は
Excubitor 経由、本体 `E:/Document/Ars/Concordia` のみ、Cc testing claim/release 必須。
子は独立 worktree で commit と Revisor local PR 提出・返却までを担当し、
親は審査修正と許可範囲のマージ反映確認まで追う。ユーザーの最新指示を優先する。
