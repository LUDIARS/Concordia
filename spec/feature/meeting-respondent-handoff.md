---
id: CC-MEETING-LINK-01
title: 組織内の予定回答者リンク
type: feature
status: draft
domain: chat-platforms
---

# 契約

Actio: a910a673-78c1-4b12-b70c-f14604da21a6。neco の「Concordiaも修正する」「組織内のユーザに限り限定的なリンクを作る」を根拠とする。
価値は [UX-CC-MEETING-LINK-W1](../ux/meeting-respondent-handoff.md)。支援境界 chat-platforms が所属確認と証明の発行・消費を所有し、Ae が予定と回答を所有する。

組織は設定された Discord guild。Cernere アカウント連携は対象外。メンバーとは非 bot かつ membership screening 完了済みの現在の所属者。

- CC-ML-INV-01: 発行・消費の両方で所属を現在の Discord API から確認。取得失敗時は拒否する。
- CC-ML-INV-02: Bot 自身の投稿と設定済み Ae origin の予定 URL の組合せだけから発行する。
- CC-ML-INV-03: 証明は予定・guild・Discord本人・audienceに固定し、5分で失効。一回の原子的消費のみ成功。
- CC-ML-INV-04: 生のランダム証明をログや公開投稿に出さない。DB はハッシュのみ保存。本人への ephemeral 応答で渡す。
- CC-ML-INV-05: Ae の回答・Cernere ID を Cc から更新しない。リンクは譲渡可能な短時間 bearer capability であり、共有しないよう案内する。

純粋な policy が入力・所属・発行上限を判断し、application が所属確認→保存→消費を順序付ける。Discord/HTTP は adapter、SQLite store が期限と原子的消費を保証する。
Cc backend と chat worker は同じ SQLite を用いる。外部 I/O を transaction に入れない。配達・消費の結果不明は再送せず、新規リンクを取得する。保存済み未消費リンクは再起動後も期限内のみ有効。
Ae の回答セッションは予定限定・12時間。発行と消費の時点で所属を確認し、成立済みセッションの毎リクエスト照合はしない。

復旧: 機能フラグを無効化し、既存投稿を通常の予定 URL へ戻す。追加テーブルは残してよい。既存回答を変更しない。
検証対象: 所属拒否、期限境界、再利用、別予定・audience、秘密の非公開、設定不備。テスト実行とサービス再起動は人間の許可範囲で行う。

## 組み込みと検証記録

Bot gateway の guild scope 確認後に専用 handler を呼ぶ。HTTP route は register-chat、共有 DB の store は bootstrap で組み立てる。ここでの bot.ts / register-chat.ts / bootstrap/core.ts の変更責務は chat-platforms の接続だけであり、他の宣言ドメインの業務判断を変更しない。
通常の incoming webhook は対話ボタンを扱えない。稼働後に Bot 所有の予定案内を投稿し、元 webhook 投稿から誘導する。既存投稿のボタンだけを対話型へ差し替えて動くとは扱わない。
本体 TypeScript 型確認は成功。全テストの型確認は既存6件のエラーで失敗（startup-policy-check、consult-fetch-link、safety-runtime、chores、forum-site-tags、usage-budget-spawn）。今回追加したテストの型エラーは報告されていない。
単体・統合・実機テストとサービス再起動は未実施。Anatomia plan は既存 domain 定義の警告を出した後20秒で応答未完了、verify も時間内に結果を取得できなかった。成功とは扱わない。
