---
title: Astra With Sidecar
type: feature
id: CC-ASTRA-WITH-SIDECAR
service: concordia
domain: agent-delegation
status: draft
updated: 2026-09-29
---

# Astra With Sidecar

## 依頼と適用範囲

necoの2026-09-29指示に基づく設計。Delegation表示名は **Astra With Sidecar**、call_name案は **astra-with-sidecar**。今回の成果は設計とActio実装タスク登録。実装は別セッションの **Opus** が担当する。Opusは本機能の開発担当であり、運用時の親モデルではない。本書はdraftで、機能の配備・有効化や測定済み効果を意味しない。

## 利用者の価値とシナリオ

[プロダクトUX](../ux/product.md)のUX-CC-W1/W2/W3/W4/W5と[委任UX](../ux/agent-delegation.md)のAD-W1/W2/W3を満たす。利用者が失うと困る状態は、合意した範囲、未回答の確認、未完了作業、成果の所在、同じDiscord会話の連続性である。

- AWS-S1: 同じDiscordスレッドで設計を相談し、範囲の定まった調整を依頼すると、Astraが判断しSolが実務を処理する。担当・待機・結果を同じ会話で追える。
- AWS-S2: 人間が「次の作業」と明示し、前の作業を引き継げる状態なら、短い引継ぎから新しい実行セッションへ移る。過去を全て説明し直さずに済む。
- AWS-S3: 子の停止、起動応答喪失、Cc再起動、切替中の投稿、遅延した審査通知があっても、同じ依頼と成果を辿れる。
- AWS-S4: 回答待ちやマージ未確認がある場合、切替待ちと理由を表示する。切替で作業が完了したことにはしない。

UXの追加評価条件は設計案。人間承認済み・実測済みとは扱わない。

## 構成と既存責務

| 主体・既存domain | 所有する責務 |
|---|---|
| Astra親 / agent-delegation | 意図理解、設計、分解、曖昧な判断、成果の採否。全ツール出力を親へ再投入しない |
| Sol medium sidecar / delegation-launch・delegation-queue | 境界の定まった作業、差分と検証証拠の返却。初期同時実行数は1 |
| session-coordination / session-lifecycle | 論理会話と実行セッションの対応、交代、世代と実行所有権 |
| session-message-layer / chat-platforms | 同一Discordスレッドへの投影、入力保存・配達・再送・重複抑制 |
| taskflow / Actio | Ccは参照と実行対応、Actioはタスク本文・業務状態の正本 |
| blackbox-decision / internal-agent-model-policy | 分類の入力・出力契約とモデル設定。権限の付与は行わない |
| observability / Memoria | モデル別・親子別・依頼全体の消費と失敗、出典・集計条件 |

新しい全権管理サービスを作らず既存domainへ所属させる。判断は純関数、手順はapplication use case、DB・Discord・provider IOはadapter。配備時にsrc/testsをdomain membershipとcc.acceptance.jsonへ対で登録する。

現行参照: [DDD](../architecture/ddd.md)、[Node.js原則](../architecture/nodejs-service-principles.md)、[taskflow v3](task-workflow-v3.md)、[worktree](implementation-worktree.md)、[委任](delegation.md)、[queue](delegation-coordination.md)、[メッセージ](session-message-layer.md)、[compaction](session-compaction.md)、[phase compaction](phase-compaction.md)。実装着手時に最新sourceとAnatomiaの所属を再照合する。

## モデル選択と委任契約

親の初期案は既存astra-midに合わせたgpt-6-astra / medium、子は既存sol-midのgpt-6-sol / medium。テンプレートと起動側でprovider/model/effortが一致することを確認し、利用不能なら明示的な停止理由を返す。指定外モデルへ黙って切り替えない。親effortの最適値は比較実験で決める。

分類は毎メッセージではなく、作業の受付または範囲が変わる時に行う。まず決定的条件を判定し、必要な場合だけ既存分類器を呼ぶ。出力はroute（parent/sidecar/clarify）、理由コード、対象範囲、不確実性、予算見積り。分類器のモデルと閾値は設定・計測対象とし、本書で架空の精度を置かない。

Sol候補: 限定したUI調整、既知仕様の分岐修正、リスト・文言修正、資料抽出、明確な再現手順と期待値のある局所修正。Astra保持: 要件や受入条件が曖昧、原因不明、横断設計、権限・データ移行・破壊的変更を含む判断。難しさだけでなくコンテキスト準備とレビューを含む総費用で選ぶ。短すぎる依頼はまとめ、分類・起動が本体を上回る委任を避ける。

委任パケットにはtask_reference、依頼版、許可根拠への参照、repo/origin/base commit、編集可能範囲、設計版・参照、受入条件、禁止事項、未決事項、検証許可、完了範囲、予算・期限、返却形式を含む。秘密や無関係な会話を複製しない。権限を本文だけで判断せず操作時に現行正本を照合する。子の独立worktreeを使い、親子の同じファイルへの同時編集を避ける。

返却は変更要約、commit/成果参照、実施した検証・未実施項目、残件、消費、失敗理由。親は差分と必要な証拠を確認し、同じ実装を丸ごと再実行しない。範囲逸脱・未解決・品質不足は親へ戻し、再委任の回数と費用上限を設ける。許可認識の失敗は能力不足と区別する。

## 会話と実行の寿命

論理会話IDはDiscord threadおよび組織に対応し、runtime session IDとは分ける。task reference、delegation run、親子関係、runtime generationも別の識別子として保持する。既存sessionへ会話の全責務を押し込まず、現在の担当をCASで一つに決める。

交代案: active → handoff_pending → handoff_saved → successor_ready → routing_switched → predecessor_drained。各遷移と相関IDを外部副作用前に保存する。旧担当の新規払い出しを止め、確定済み引継ぎから後継を準備し、受信先を原子的に切り替えてから旧runtimeを終了する。後継準備中は旧担当も新規処理をしない。準備失敗は旧担当の所有権を照合して再開か待機とする。停止済み担当を無条件で復活させない。

Discord入力はmessage IDで受理を重複抑制し、順序・担当世代・配達状態を永続化する。交代中の入力を保存し後継へ渡す。送信応答喪失は結果不明として照合し、無条件再送しない。全境界のexactly-onceは約束せず、永続inbox/outbox・冪等キー・CASで抑制する範囲を実装で示す。停止・取消・人間回答を通常作業より優先する。キュー件数、入力サイズ、IO期限、drain待機時間に上限と超過時の表示を設ける。

「次の作業」は人間の直接指示と現在の作業状態を組み合わせて判定する。引用・ツール出力・AI発言・自動確認内の文字列では起動しない。MVPは明示指示のみ。自動検出は観測後の設定で有効化する。

未回答質問、実行中の子、未確定副作用、提出結果不明、審査中・許可済みマージ未完了は消さない。MVPではこれらがある自動交代を保留する。人間による引継ぎを扱う拡張では、担当移譲と通知ルートの保存が前提。遅延通知はtask/runへ紐づけ、終了runtimeへの再注入で紛失させない。子終了・PR提出・審査通過・merge・反映は別事実として扱う。

## コンパクションと設計コンテキスト

同一作業を継続する長いセッションは既存compactionを使い、作業境界では新セッションと引継ぎを選ぶ。閾値だけで未完了作業を捨てない。引継ぎ保存前にclear/compact/終了しない。引継ぎには合意済み決定と理由、現行成果・差分、実repo/branch、残件、許可範囲、人間待ち、外部操作の相関ID、task/run、必要資料と版を保存し、受領確認を残す。Actio本文の第二正本は作らない。

共有するのは版管理された短い設計パッケージと必要資料への参照。AstraのKVキャッシュをSolへ転送する設計にしない。同じモデルで互換なリクエストの共通prefixが一致した場合にキャッシュが効く可能性はあるが、任意のセッションへキャッシュをexport/importする保証はない。静的ルール・共通資料を先頭、可変の依頼を後方にまとめる。モデル・ツール定義・prefix変更やcompactionによるキャッシュ再構築を費用に含める。CodexがAPI向けcache設定を公開するとは仮定しない。

参照: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Compaction](https://developers.openai.com/api/docs/guides/compaction)。2026-09-29の調査に基づき、実装時に利用providerの能力を再確認する。

## 不変条件と復旧

CC-INV-01〜08を適用する。特に対象・権限維持、依頼同一性、証拠のない完了禁止、資源所有、人間待ち維持を守る。

| 失敗 | 保存・復旧 |
|---|---|
| 起動応答喪失 | 同一request/runを照合、未起動と断定して二重起動しない |
| classifier停止・不確実 | 親保持または確認待ち。許可を拡張しない |
| 旧世代から遅延結果 | run・依頼版・baseを照合し結果保存。現担当の状態を上書きしない |
| lease喪失・Cc再起動 | 新規取得停止、既存runと受信/outboxを照合。保存先を先に閉じない |
| Actio停止・scope不一致 | 準備不足を表示。Markdown本文や別組織タスクへフォールバックしない |
| cache miss・compaction失敗 | 性能劣化と業務失敗を分け、原文参照・最後の確定handoffを保つ |
| Discord配達失敗 | 業務結果を保持し未配達を表示。成果を再生成しない |
| 人間の停止・取消 | 停止世代を保持し自動再開禁止。既発行の外部操作は別途照合 |

## 費用の根拠と評価

ローカル監査: workspaceのsession-logs/codex-cost-audit/2026-09-29/report.md、model-and-compaction.md、sessions-response-records.csv。期間は2026-09-22 00:00〜09-29 00:00 JST、当該Windowsのarchive含むログ。実請求額や全端末利用量ではない。

40%は「Astra消費の半分を同量tokenのSolへ置換し単価80%減」という仮定。4.028%は前回の実際に選んだ11区間を5.6系へ置換した全体比で、対象割合・置換先・母数が異なる。同じ11区間のGPT-6 Sol換算は5.2218%。40%を本機能の目標達成実績にしない。

実際のSol子6件は変更報告4・許可認識で停止2。品質同等性や全面置換の証拠ではない。120回のcompactionでは前後5リクエストの入力中央値222064→37387、費用中央値6.454675→2.214075、compact自体中央値12.92155 credits。単純償却約3リクエストは相関の概算で一律閾値ではない。

総費用 = 親 + 分類 + 子 + 引継ぎ/compact + レビュー + 再試行。response IDでtoken記録を重複排除し、cached input・非cached input・output・compactを分ける。未価格モデルを0にしない。Memoria集計の未価格・archive・期間/件数上限の問題は別対応として可視化し、不完全な集計を採用判定に使わない。

同じ種類・難易度・完了条件の作業でAstraのみと比較し、完了あたり費用、初回受入率、手戻り、人間介入、所要時間、読み直し量、キャッシュhit、切替失敗・重複実行を測る。成功例だけを選ばず失敗を含める。分類器の誤判定も記録する。節約率の合否値は小規模実測後に決める。

## 実装順と受入

1. 既存テンプレートを再利用し、Astra With Sidecarを追加。短い委任契約、独立worktree、子1件、親への成果返却を実装。
2. 同一Discord会話の永続対応とinbox/outbox、明示「次の作業」での交代・引継ぎを実装。
3. 分類・費用・品質の観測を追加し、観測後に自律振り分けの適用範囲を調整する。既存の通常Delegationは保持する。

受入ケース: 正しいモデル/effort、曖昧依頼の親保持、権限維持、子差分採用、競合編集禁止、重複入力/起動照合、交代中入力、再起動、stale結果、回答待ち、停止取消、遅延審査、未完了merge、cache miss、予算超過、Actio停止。単体の遷移契約とadapter境界、許可された環境でのDiscord通し確認を区別する。未実行を成功扱いしない。

展開は無効状態の定義→限定利用→計測→適用拡大。ロールバックでは新規委任/交代を停止し既存runの照合・結果保存を続け、通常Astraへ戻す。会話・task・成果対応を削除しない。実装は別Opusセッションで行い、テスト・サービス操作・mergeはその時点の人間の許可範囲に従う。

## 実装状態 (2026-09-29)

計画: [実装計画](../plan/2026-09-29-astra-with-sidecar-implementation.md) (plan v1、neco 承認)。以下は実装済みのコードの所在で、配備・実地確認済みを意味しない。

| 責務 | domain | 実装 |
|---|---|---|
| プロファイル・テンプレート一致 | agent-delegation | `src/delegation/sidecar/profile.ts`、seed `astra-with-sidecar` (`src/delegation/seed.ts`) |
| 委任パケット・起動可否・起動ガード | agent-delegation | `packet.ts` / `gate.ts` / `invoke-guard.ts`。`/v1/delegation/invoke` の先頭で適用 |
| 返却点検 | agent-delegation | `return-contract.ts`。status 報告の `sidecar_return` を親通知へ反映 |
| 振り分け判定・記録・観測 | agent-delegation | `route-policy.ts` / `records-repo.ts` / `observation.ts`、`/v1/delegation/sidecar/{route,observation}` |
| 論理会話・入力・交代 | session-coordination | `src/control/conversation/` (意図判定・状態機械・引継ぎ・repo・service・reconciler・Cc adapter) |
| Discord 受付 | chat-platforms | `src/discord/conversation-ingress.ts`、`ingress.ts` の session thread 経路 |
| 永続化 | persistence | migration 114 (`sidecar_route_decisions` / `sidecar_invoke_events` / `conversations` / `conversation_inputs` / `conversation_handoffs`) |

実装上の決定:

- 子 worktree は委任パケットの `base_commit` から作る (`InvokeInput.base_ref`)。親の contract の model / effort / branch は子へ持ち込まない。
- 起動の試行回数は `sidecar_invoke_events` の許可・起動失敗記録から数える (実装委託の Actio 封印で run の args が置き換わるため)。
- 会話は Session forum スレッドで、結び付いたセッションが `astra-with-sidecar` の時だけ作る。後継は同じスレッドの forum trigger で起動し、既存の Actio task を続ける (`task_binding: "caller"`、新しい task は封印しない)。引継ぎに `actio:` 参照が無い場合は後継を起動せず旧担当へ戻す。
- 交代中の入力は保存し、切替後に元の順序で後継へ渡す。きっかけの「次の作業」は引継ぎ本文に含めて渡す。停止・取消は routing_switched 前なら交代を中断して旧担当へ戻す。
- 引継ぎ保存の期限 15 分、後継起動の照合期限 10 分、保留入力 50 件、1 入力 16,000 文字。reconciler は 30 秒周期。

未実装・未確認:

- 費用: provider の消費記録 (response ID 単位の重複排除、cached / 非 cached / compact の区別) は未接続。観測 API は費用を `not_measured` と返す。
- 分類器: 口 (`SidecarRouteClassifier`) のみ。未設定のため、決定的条件で決まらない依頼は親保持になる。
- テンプレートは `forum_tag` を立てていない。Session forum からの起動を有効にするのは人間の判断 (限定利用の開始)。
- 旧担当の終了は発話による終了要求と同じ印で行う。遅延した審査通知の後継への付け替えは、MVP では PR が残る間は交代しないことで回避している。
- Discord 通しの確認、テスト実行、配備は未実施。
