---
id: CC-CONSULT-TITLE
status: draft
domain: consultation
---

# 公開相談の短いスレッド名

neco の開始指示「相談開始したらチャンネル名をHaikuで要約、次回は変化が薄ければそのまま」に対応する Actio task は `9eb5faee-88ec-4e23-a4a8-a6e45fd341cc`。価値は UX-CC-W2/W4/W6、情報境界は CC-CONSULT-INV-03/05、依頼同一性・所有権は CC-INV-03/07/08。

既存 consultation の支援責務として、公開部署相談（有効な intake-enabled ユースケースのセッション）の名前を短くする。private 相談は既存の内容を含めない名前を維持し、要約にも送らない。手動固定名も変更しない。一般の作業セッションのタイトル反映は変更しない。

Haiku は共有 Claude CLI runner の conversation-only モード、30秒上限で利用する。入力は公開相談の現在タイトル最大2000文字と以前の確定済み要約だけ。短い名前（48文字以内）と意味の変化の有無を JSON で返す。未初期化なら要約を採用し、確定済み要約から薄い変化なら名前を保つ。状態・モデル・project の装飾は既存 forum formatter が所有する。元のセッションタイトルは改変しない。

Discord adapter が要約反映記録を既存 scope-aware DiscordConfigRepo 経由で所有する。外部rename前に変更先を保存し、結果不明は同じチャンネル名を読み戻して照合する。未確認のrenameを自動再送しない。要約呼出し自体は読み取りで、再起動後の再生成を許す。セッションの終了、Bot停止、チャンネル再利用、手動固定、より新しいタイトルで古い結果を適用しない。入力は最大32件、同時要約は4件まで、同一セッションの待機は最新状態1件にまとめる。

AT-01: 開始時に短い要約名へ変更する。AT-02: 同じ話題の言い換えは名前維持、重要な話題転換は更新。AT-03: private/固定/終了/所有権喪失/古い結果では変更しない。AT-04: rename結果不明を照合し、停止後に確定したrenameの結果を保全する。AT-05: 失敗・不正応答は既存名を保ち、本文をログへ出さない。

Anatomia plan --no-llm hash `7a12f50715f67e7c` は既存 consultation/dialogue-context を候補とした。新規ドメインなし。既存2domain宣言不正とcache EPERM警告は今回未修正。PfのConcordia登録と仕様一覧は先の調査で確認済みだが、本変更のPf承認は未確認。repoのUX/feature/domainが正本。

復旧: Botへの要約接続を差し戻す。セッション本文、手動固定、private権限、保存済み対応記録を削除しない。未確定renameは保存先と現表示を照合してから運用で復旧する。

検証: 登録テストを同じ変更単位で追加する。ローカル実行テスト・サービス操作・実Discord評価は未許可のため未実施。型確認・静的登録検証とRevisor審査結果を追記する。

backend 型確認は成功、テスト登録856件は整合。全体テスト型確認には既存の startup-policy-check / usage-budget-spawn の ProviderName、consult-fetch-link の宣言不足、safety-runtime の不完全な SessionsRepo fixture の4件が残る。今回の変更ファイルの型エラーはない。Revisor 実行結果は提出後に照合する。
