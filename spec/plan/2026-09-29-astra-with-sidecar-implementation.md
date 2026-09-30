# Astra With Sidecar の実装 (Cc / actio:2261f19a)

## 目的
設計書 spec/feature/astra-with-sidecar.md (CC-ASTRA-WITH-SIDECAR, 設計 commit 108b43bd) を Concordia に実装する。
同じ Discord 会話で、Astra 親が判断し Sol medium の Sidecar が範囲の定まった実務を行い、明示「次の作業」で実行セッションを交代しても、許可・回答待ち・未完了作業・成果の所在を失わないようにする。
SQLite migration 114 を追加するため、vibes から plan へ昇格して承認を求める。

## 受け入れ条件
- 新テンプレート astra-with-sidecar (Astra / codex / gpt-6-astra / medium) を seed し、子は既存 sol-mid (gpt-6-sol / medium) を使う。テンプレートと起動側の provider/model/effort が一致しない場合は明示の停止理由を返し、別モデルへ黙って切り替えない。
- Sidecar 親からの /v1/delegation/invoke は、子テンプレート固定・親の contract model/effort を子へ持ち込まない・委任パケット必須 (task 参照、依頼版、許可根拠、repo/origin/base commit、編集範囲、受入条件、禁止事項、未決事項、検証許可、完了範囲、予算、返却形式)・秘密らしい値を拒否・同時実行 1 (結果不明の queued/launching も数える)・同じ依頼の再委任上限 3・子 branch は親 branch と別・独立 worktree を base commit から作る。許可・拒否はすべて記録する。
- 子の status 報告に返却項目 (要約、commit、実施/未実施の検証、残件、消費、失敗理由と分類) を載せられ、欠けていれば親への通知に明示する。許可認識の失敗は能力不足と区別して表示する。
- 振り分け判定 API: 決定的条件 → 分類器 (未設定・失敗・不確実は親保持) の順で parent/sidecar/clarify、理由コード、不確実性、予算見積りを返し、判定を記録する。
- Session forum スレッドで Sidecar 親に紐づく論理会話 ID (platform / 組織 / guild / thread) を runtime session と分けて保持し、担当と世代を CAS で 1 つに決める。入力は message ID で重複抑制し、順序・担当世代・配達状態を永続化する。配達結果不明は「不明」とし無条件再送しない。
- 権限のある人間が「次の作業」と直接書いた時だけ交代を始める (引用・コード内・否定形は対象外)。未回答質問・実行中の子・未マージ PR・結果不明入力があれば交代を保留し、理由を表示する。交代は handoff_pending → handoff_saved → successor_requested → successor_ready → routing_switched → predecessor_drained を各副作用の前に保存して進め、交代中の入力は保存して後継へ順に渡す。停止・取消は交代を中断して旧担当へ戻す (切替後は戻さない)。引継ぎパッケージが保存されるまで旧担当を終了しない。
- 再起動後も reconciler が交代状態を照合して進める。後継起動の結果不明は run を照合して二重起動しない。保存期限切れ・後継起動失敗は旧担当へ戻し、会話・task・成果の対応を削除しない。
- Sidecar 親子の run・判定・拒否を集計する観測 API (親/子/再試行/拒否件数、所要時間。価格不明を 0 にしない)。
- domain membership / specRefs と cc.acceptance.json に src/tests を対で登録する。単体テストを同じ変更単位で書く。

## スコープ (編集可ディレクトリ)
- src/delegation/sidecar/ (新規)、src/delegation/seed.ts、src/delegation/contracts.ts、src/delegation/service.ts (base_ref の受け渡しのみ)
- src/control/conversation/ (新規)
- src/api/delegation.ts、src/api/delegation-sidecar.ts (新規)、src/api/register-core.ts、src/bootstrap/core.ts
- src/discord/ingress.ts、src/discord/bot.ts (会話受付の配線のみ)
- src/db/schema.ts、src/db/migration-ledger.ts (migration 114 の追加のみ。既存 migration は触らない)
- spec/feature/astra-with-sidecar.md、spec/plan/、spec/domains/*.domain.json、cc.acceptance.json、各テストファイル

## タスク分解
1. 段階 1 の純関数: profile / packet / gate / return-contract / route-policy とテスト
2. migration 114 (sidecar_route_decisions、sidecar_invoke_events、conversations、conversation_inputs、conversation_handoffs) と repo・テスト、凍結台帳の追記
3. invoke guard の組み込み (/v1/delegation/invoke)、base_ref による子 worktree 起点、status 報告の返却点検、テンプレート seed
4. 段階 2 の純関数: 入力意図判定・交代状態機械・保留条件・引継ぎパッケージとテスト
5. 会話サービス (受付・交代開始・パッケージ保存・後継起動・切替・drain) と reconciler、API、Discord ingress 配線
6. 観測 API (route / invoke 記録と親子 run 集計)
7. domain / specRefs / cc.acceptance.json、設計書の実装状態追記、1 PR (Revisor local PR) で提出

テスト実行・サービス再起動・merge は neco の許可範囲に従う (実行しない分は PR に未実施として明記する)。
