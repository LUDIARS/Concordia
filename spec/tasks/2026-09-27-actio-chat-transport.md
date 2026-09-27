---
task: actio-chat-transport
project: Cc
kind: feature
created: 2026-09-27
memory_links: []
---

Actioの通常チャンネル連携に認証済み配送ポートを提供する。契約はCC-ACTIO-CHAT-01、価値UX-CC-W1/W4/W5、不変条件CC-INV-02/03/06。人間の開始承認: neco「実装開始添付可」「OKそれで実装はじめて」。

Actioのfeat/sprint-chat-integrationから呼ぶ。会話への任意参加はDiのfeat/actio-discussion-participationが担当する。配備の有効化・実投稿・再起動・テスト・マージは実施していない。静的TypeScript確認のみ。受入テストをcc.acceptance.jsonに対応付け、Revisorへ審査依頼する。

静的確認: 本体のtsconfig.jsonは通過。tsconfig.test.jsonは今回変更していないwork-submission-routes.test.ts、image-inbox.test.ts、revisor-local-pr-client.test.ts、ontime-runtime.test.tsの型エラー4件で失敗。新規チャットファイルの型エラーは出ていない。全体検証成功とは扱わない。

Anatomiaのstaged diff静的検証は5ゲートすべて通過（pass: true）。これは動作テストの実行結果ではない。

Revisor #2060 の競合指摘を受け、local main 541643dd 上にrebase。cc.acceptance.jsonとhttp-interface/runtime-orchestrationのドメイン宣言について、mainの開発ツール登録と本件の登録を両方保持した。mainの仕様参照・テスト対応の保持を構造比較で確認。本体TypeScriptとmainとの差分に対するAnatomiaの5ゲートは再度通過。セッションからのテスト実行・main更新は行っていない。
