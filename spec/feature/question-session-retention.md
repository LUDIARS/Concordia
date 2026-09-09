# 終了セッションの未回答質問

状態: draft / UX: UX-CC-PRODUCT / domain: governance

人間が回収する未回答一覧に、通常セッションの終了・ロスト後の質問を残さない。
閉鎖の状態所有者は既存 discord_pending_questions。回答履歴と閉鎖は区別する。

- QRET-1: 通常セッションの ended / lost（その後の abandoned と削除も含む）で未回答質問を閉じる。
  active / blocked は生存状態であり閉鎖しない。
- QRET-2: TaskflowRuntime が追跡する delegation run の child_session_id に該当するセッションは、非 active になってから 86,400 秒保留する。通常の直接 spawn は対象外。
- QRET-3: close_after を質問行に保存する。同じ終了通知・Cc 再起動・セッション行削除で期限を延長しない。期限前に active へ復帰した場合は保留期限を解除し、次の終了は新しい非稼働期間として扱う。
- QRET-4: closed_at / close_reason を設定し、answered_at と answer_text は変更しない。閉鎖は人間の回答としてイベント送信しない。
- QRET-5: inbox の ask-card / inquiry-ask-human、親エスカレーション、セッション未回答照会から閉鎖済みを除外し、古い質問への回答は拒否する。

起動時・session 状態イベント・質問投稿時に照合し、30 秒周期で保留期限切れを回収する。
既存行は終了イベント、ended_at、last_seen_at の記録から非稼働時刻を復元する。
時刻記録もセッション行も無い孤児は、通常質問なら初回照合で閉じる。
workflow run の記録だけ残る孤児は初回照合から 24 時間とする。
回答済み・閉鎖済みは変更しない。保留中は未回答のままであり、回収一覧に残る。

Discord 投稿済みカードの自動削除は行わない。古いボタンからの回答受付を拒否する。
confirm 承認と Director blocked 工程は別の状態所有者であり、この質問閉鎖の対象に含めない。

移行: schema 98 で nullable 列を追加。配布後に既存未回答の照合が走る。
復旧: closed_at を消して自動再開する運用は行わず、必要なら新しい質問を発行する。
検証: 型ビルドと静的差分確認。ユーザー指示によりテスト・起動・再起動は未実行。
