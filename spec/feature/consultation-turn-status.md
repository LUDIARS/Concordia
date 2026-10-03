---
id: SPEC-CONSULTATION-TURN-STATUS
status: draft
---
# 応答の開始時刻と終了状態

2026-10-03 neco の開始指示。Actio: ad04b269-483c-403e-8e8b-ae9f482cf621。
UX-CC-W4/W6、CC-INV-02/03/06を適用する。最終回答だけを表示する部署でも、応答開始を知り、失敗・中断後を作業中と誤認しない。

状態所有者は session-message-layer。Lictor は provider の開始・終了を `turn` transcript frame へ変換する。本文・思考は状態に含めない。フレームは kind/start|completed|interrupted|failed、provider turn ID、観測元の UTC 開始時刻を持つ。Cc は session_messages の専用キーに現在の turn 状態を永続化する。同じ開始の再送で時刻を変えず、古い seq の終了で新しい turn を終了させない。session ended/lost は未完了 turn を中断にする。Cc再接続時は同じ保存行を読む。

Discordは既存の配達台帳を使って同じ状態行を編集する。最終回答のみの有効設定でだけ表示する。WebUIは保存行から秒付きの開始時刻を表示し、通常表示部署の従来表示を維持する。providerの開始時刻を取得できない場合は時刻を捏造しない。受入: 開始の重複/逆順/再起動、完了/失敗/中断/切断、別sessionへの非干渉、非公開本文の非混入。

会社別の既定値は#2329の `departmentOutputMode` と同じ解決境界を使う。子会社の総務（general / general-affairs）の継承値だけはthinking/intermediate/inject_transcript/context_usageをoffとし、本社・別部署・明示設定は保持する。#2329の未マージUI変更は取り込まない。FINAL ANSWER見出しはCcの装飾だけ除去し、回答本文は変更しない。

復旧: providerからの再送はseqとturn IDで照合し、既存のメッセージ・Discord配達IDを再利用する。未知状態を成功に変換しない。コード rollback は状態メタデータを無視でき、会話原本の削除を要しない。
テストはsourceと同時に記述し受入台帳に登録する。テスト実行・サービス操作・実機確認は別途許可範囲に従う。
