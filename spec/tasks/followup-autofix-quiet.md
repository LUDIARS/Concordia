---
task: followup-autofix-quiet
project: Concordia
kind: 実装
status: review
created: 2026-11-16T00:00:00.000Z
source_session: lictor-06d6582d-d668-4fd7-a9e5-91a53221f617
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# 自動確認: 審査失敗は人間に聞かず直して再提出し、作業状態が見える間は止めず、変化なしは報告しない

neco 指示 (2026-11-16) の 4 点を自動確認 (stall nudge) に入れる。親セッション lictor-24e68c85 からの委託。

### 価値 / 不変条件

- 審査テスト失敗 (state=review-failed) は人間の判断を待たずに所見・失敗記録を読んで修正し、同じ PR へ再提出する。通るまで繰り返す。
- 人間の判断が要らない残作業は確認を求めずに進める (全 state の本文)。
- Goal & Go を基本とし、Cc が作業状態を確認できる間 (state が unknown 以外) は 3 アウトで止めずに残作業が無くなるまでループする。
- 自動確認は止めずに進捗を記録し、作業状態が前回と同じ回は確認 (inject) するが Discord へは報告しない。
- 維持する不変条件: 人間待ち (human-wait)・未回答の質問カード・ask 待ち・人間応答待ちの永続 gate・部署の auto_check off・前回確認に無反応なら送らない・unknown の同一内容は一度だけ・委託の定期進捗 (scope) の上限。

### 変更

- `src/control/followup-progress.ts` (新設): 作業状態の指紋 `followupProgressFingerprint` (state・workflow・タスク status/reason・PR status/checkStatus・委託 status・関連付け失敗・取得不能の取得元をソートした JSON。活動時刻は含めない)、metadata `cc_followup_progress` = `{fingerprint, unchanged_count, last_checked_at, last_changed_at}` の読み書き、変化なし案内、`[変化なし]` 判定。
- `src/control/stalled-session-nudge.ts` (runOnce): 冒頭の 3 アウト早期 skip は状態照会なし・委託の定期進捗だけに残す。状態照会がある構成は作業状態を解決した後、state=unknown (照会失敗を含む) のときだけ 3 アウトで止める。unknown 以外では停止予告を添えない。送信ごとに指紋を記録し、前回と同じ回は `session.stall_nudged` を emit せず本文に変化なし案内を添える。
- `src/control/session-followup-state.ts`: review-failed の自動修正・再提出の指示 (three-out-rule・結果不明の再送禁止を含む) と、全 state 共通の「人間の判断が要らない残作業は確認を求めずに進めてください」を追加。
- `src/platform/session-message-relay.ts`: assistant 発言の本文が trim 後ちょうど `[変化なし]` なら Discord / Slack へ流さない。定数は control/followup-progress.ts に置き platform から参照 (platform → control は既存例あり、discord/slack → control 禁止ルールには触れない)。
- `src/control/auto-confirm-strikes.ts`: 冒頭コメントを新指示に合わせて更新 (処理は変えない)。
- `skills/session-followup/SKILL.md`、`spec/feature/autonomous-work-continuation.md` §2 (3 アウト・継続誘導・「変化なしは報告しない」節を新設)、`spec/feature/task-linked-followup.md` を新挙動に更新。
- `cc.acceptance.json` に followup-progress.ts / session-message-relay.ts を追加、`spec/domains/autonomous-continuation.domain.json` の membership に followup-progress を追加。

### 対象境界

- 変更するのは自動確認 (stall nudge) の判定・本文と、チャット面への転記判定だけ。Revisor・Actio・委託の状態取得 (session-followup-snapshot.ts) と Discord 投稿処理 (bot.ts) は変えていない。
- 新しい実行許可は与えない。本文の既存の「未許可の session-end・push・テストや範囲拡張は行いません」は残す。

### 復旧方法

- metadata `cc_followup_progress` を消せば、次の自動確認は「変化あり」として従来どおり Discord へ通知される。
- 3 アウトを全状態で効かせる従来挙動に戻すには、runOnce の `strikeExempt` を常に false にする (1 行) か、この PR を revert する。
- `[変化なし]` の非転記は session-message-relay.ts の 1 行を外せば戻る。

### 検証

- 実施: `tsc --noEmit -p tsconfig.json` (エラーなし)、dependency-cruiser で変更ファイルを走査 (新規違反なし。既存の periodic-progress-policy の循環・periodic-progress-request → cost の 2 件は本変更と無関係)。
- 未実施: vitest (手元でのテスト実行は許可されていないため。検証は Revisor 審査に委ねる)。サービスの再起動・反映 (未許可)。
- 追加・更新したテスト: `src/control/followup-progress.test.ts` (新規)、`src/control/auto-confirm-strikes.test.ts` (unknown 以外は 4 回目以降も送る・review-wait の変化なし非通知・状態変化で毎回通知・永続 3 アウト下の review-failed 送信と unknown 停止・状態照会なしの停止と再開)、`src/control/stalled-session-nudge.test.ts` (同一状態で stall_nudged を出さず案内を付け、変化で出す)、`src/platform/session-message-relay.test.ts` (`[変化なし]` だけの assistant 発言を Discord/Slack とも落とす)、`src/control/session-followup-state.test.ts` (review-failed 本文・全 state の文言)。

### 受け入れ条件

- review-failed の自動確認本文に、人間に聞かず所見を読んで修正し同じ PR へ再提出する指示が出る。
- state が unknown 以外では、人間の反応が無くても 4 回目以降の自動確認が送られる。人間待ち・質問カード・ask・人間応答待ち・auto_check off の各ゲートは有効のまま。state=unknown と状態照会なしの構成は従来どおり 3 回で止まる。
- 作業状態の指紋が前回と同じ回は session.stall_nudged が出ず、本文に変化なし案内が付く。変わった回・初回は従来どおり出る。
- `[変化なし]` だけの assistant 発言は Discord / Slack に流れない。それ以外の発言は従来どおり流れる。
- 上記がそれぞれテストで固定されている。
