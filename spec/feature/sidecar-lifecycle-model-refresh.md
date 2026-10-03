---
id: CC-SIDECAR-LIFECYCLE-MODELS
status: draft
updated: 2026-10-03
---

# 常駐サイドカー・待機判定・モデル更新

## 価値と範囲

neco の2026-10-03指示「Ccの修正については設計してSolに委託」、Sol 6.1への更新、
毎日JST 10時のモデル追従、固定commitのLapilliからフラグ付きInterfaceでCcデータ参照、を扱う。
先行の職場WebUI PR #2329 は保留し混ぜない。キャッシュ命中や費用削減は未測定。
UX-CC-W2/W3/W5、UX-CC-AD-W1/W2/W3、AD-S1/S3/S4/S5を維持する。
失うと困る状態は同じ担当子の文脈、明示的な人間待ち、未完了の作業/審査、実効モデルの出典である。

所属: coreのagent-delegationは委任依頼・子の再利用を所有する。
支援境界autonomous-continuationは待機判定と自動確認を所有する。
モデルカタログ/更新は支援境界として宣言し、実装前にsource/testsのmembershipとspecRefsを登録する。
Lapilliのone-shotは支援ライブラリでありCcを所有せず、HTTP/DB/定期実行へ直接依存しない。
CC-INV-01/02/03/04/05/07、以下SC-LIFE/WAIT/MODEL各条件を適用する。

## 観測と修正方針

- sidecar/profile.ts は gpt-6-sol を固定しテンプレート一致を強制。DBのモデルだけ6.1へ変えると起動が拒否される。
- stalled-session-nudge.ts は通常の自動確認でも claimHumanResponseConfirmation を呼ぶ。
  このフラグはAIの応答では解除されず、人間待ちでない継続も停止する構造。
- human-waitとpending questionの保護は既に存在するが、watchdog等の別送信経路との共通適用を点検する。
- 終了runのreaper、taskflowのteardown、partialの再委託は子の寿命と作業報告を結びつけている。
- Lapilli packages/one-shot/src/models.js のsol既定値もgpt-6-sol。
  同期公開API/CommonJSを維持する互換契約がある。

## A. 常駐子と依頼の寿命

SC-LIFE-01: 依頼の結果と子プロセスの寿命を分ける。作業完了/失敗報告後も、常駐として登録された
子は待機して次の依頼を受ける。一般の単発delegationの終了挙動は維持する。
所有単位は親session・repository/organization・provider/model・子generation。
子は一度に1依頼のみ。task_reference + request_versionを依頼同一性とする。

SC-LIFE-02: 続行API/use caseは同じ生存子のsession/threadへ新しい依頼を配送する。
状態はstarting/busy/idle/closing/closed（不明結果は独立のdelivery状態）を永続化。
idleはunfinished workではなく、queueの実行枠と常駐数を別に数える。
busyへの遷移はCASで確保し、配送前に依頼を保存。同じ依頼の再送は既存receiptを返す。
配送応答喪失では照合待ちとし、同じ作業を別の子へ発行しない。

SC-LIFE-03: 結果は現在の依頼ID/generationへ紐付け、過去の結果で新しい依頼を終了しない。
run statusで成果を保存し、sidecar lease/sessionは再利用の正本とする。終了済みrunをrunningへ巻き戻さない。
親は設計と採否を行い、子の編集範囲を同時編集しない。

SC-LIFE-04: reaper/watchdog/自動session-endは常駐idle子をゾンビ・停滞と判定しない。
人間の明示停止、親の終了、所有権喪失時は保存済み結果を保持し、正規lifecycle経由で閉じる。
Cc再起動ではsessionと所有generationを照合し、存在不明を新規spawnの許可にしない。
モデル日次更新を理由に作業中の子を閉じない。実行中モデルは固定し次の新規起動から適用する。

## B. 自動確認の待機意味

SC-WAIT-01: waiting_human（明示human-wait/未回答質問/審査器の明示人間承認待ち）は全自動継続経路で抑止。
通常の自動確認送信をhuman-waitへ変換しない。人間からの有効な回答・解除だけがこれを解く。
AI回答、転記エコー、typing/user_activity、時間経過は人間回答の証拠にしない。

SC-WAIT-02: task-active/delegation-wait/review-waitは作業追跡の状態であり、人間待ちではない。
子や審査器の通知で再評価し、通知欠落の回復は既存の間隔・cooldown・期限内で照合する。
必要がない同文injectは抑止するが、人間回答を要求し続けるゲートにしない。
busyな子/審査中headへ親が再実装・重複提出することを許可しない。

SC-WAIT-03: 状態解決を純関数で共通化し、送信直前にも最新binding/人間待ちを再確認。
再起動後も重複抑止を保つ。未知/失敗を人間待ちや完了と勝手に変換せず理由を残す。
既存のhuman_response_confirmationは本来の対人確認に限定し、nudge配達の状態と分離する。

## C. モデルデータの所有とJST日次更新

SC-MODEL-01: Solの初期更新先はgpt-6.1-sol。モデルIDはローカルCodexカタログ
（2026-10-03取得）と公式App Server文書で確認した。effortはmediumを維持し能力情報で検証する。
https://learn.chatgpt.com/docs/app-server#message-schema

SC-MODEL-02: Ccはprovider/role→model ID・能力・出典・観測時刻・revisionを持つ公開可能な
カタログsnapshotを所有する。候補一覧と採用済みrole pointerを分ける。
既定追従テンプレートとsidecar profileは同じ解決ポリシーを読む。コードの旧モデル固定との二重管理を解消する。
手動の明示モデルpinは保持する。既存標準solテンプレートの旧既定だけ6.1へ移行し、任意の手動モデルは上書きしない。

SC-MODEL-03: timezone Asia/Tokyo、cron 0 10 * * *。モデル更新専用schedulerを1つ所有する。
JST日付とleaseを保存し多重worker/再起動の二重更新を防ぐ。当日10時を過ぎた起動で未実施なら1回追いつく。
有限timeout・ページ数・候補数・再試行上限を設け、stopでtimer/I/Oを解放する。

SC-MODEL-04: providerの正式モデル情報と、その実行providerが利用できる能力情報をadapterで取得する。
Codexは公式model/listのupgrade情報・effort・可視性を優先し、古いキャッシュだけを最新調査成功にしない。
他providerも正式な取得adapterが確認できたものだけ自動採用する。未対応providerは明示表示し旧値を保持。
自由文の検索結果やモデル名の文字列ソートだけで採用しない。同じ役割/familyの安定モデルを選び、
preview/別tierへの変更は自動で混ぜない。認証情報を読み出して別APIへ流用しない。
正式一覧にupgrade edgeが無い場合も、厳密な `gpt-<major>[.<minor>]-<role>` 形式の
同一role/family安定候補を数値tupleで比較し、medium/text能力を検証して最新を選ぶ。
未知形式は比較対象にせず現行維持の理由を残す。辞書順ソートでlatestを推測しない。

SC-MODEL-05: 調査/能力検証/採用を分離し、採用はrevision付きtransaction/CASで更新。
調査失敗・不正情報・能力不一致は既存の採用snapshotを維持し、結果理由を記録する。
更新履歴はbefore/after/revision/出典を保存。rollbackは過去snapshotへの明示切替で、実行中runを変えない。
cronでGit/package/依存commitを書き換えたり、ライブラリを自動publishしない。

## D. 固定commitのLapilliから動的データを読むInterface

SC-MODEL-06: one-shotにCc固有URLやSDKをimportしない。
ModelCatalogPort.resolve({provider,role,context}) -> Promise<{modelId,revision,observedAt,expiresAt,capabilities}>
を構造的Interfaceとして定義する。利用側のCc HTTP adapterがservice catalogでendpointを解決して注入する。
フラグ無効は既存bundledモデルと同期APIのまま、通信ゼロ。
フラグ有効はrole指定時だけportを呼び、明示モデルIDはそのまま、明示環境overrideも優先する。
context suffix、provider照合、effort検証を維持する。

SC-MODEL-07: prepareOneShotAsync/spawnOneShotAsync等の追加APIを使い、既存spawn/execFile/prepareの
同期戻り値・CommonJS互換を壊さない。オプションからlibrary専用フィールドを除きchild_processへ渡す。
外部フラグtrueでport欠落/不正/期限切れ/取得失敗なら明示エラー。bundledへ黙って戻さない。
許容期限内の検証済みsnapshotキャッシュはrevisionと取得元を返し、期限後は再取得する。
library commitが同じでもCc revision更新後の次回呼出しが新モデルを選べることをテストする。
既存のsubscription認証・shell:false・cancel/stdio・起動回数契約を維持する。

## 検証と委託

### 実装契約と復旧

- 常駐子の正本は `resident_sidecars`、依頼同一性/配送結果は `resident_sidecar_requests`。
  `/v1/delegation/invoke` の既存入口で同じ親・repo・organization・branchを照合し、
  続行も初回と同じguard/テンプレート/Actio封印経路をspawn=falseで通す。
  初回前のstarting予約と続行前のbusy CASを保存する。既存WSには配送ACKがないため
  配送後はunknownを保存し、run結果で照合する。unknownは再spawn許可にしない。
  `GET /v1/delegation/sidecar/residents/:parent`、generation指定の
  `POST /v1/delegation/sidecar/residents/:parent/close` を追加する。
- 他generationのsessionは上書き/終了しない。存在不明は予約を保全する。
  旧source無しhuman_response_confirmationは真正質問と区別不能なので解除しない。
  nudge由来を確実に刻印できたものだけ移行し、出典不明は人間応答/明示解除を待つ。
  通常nudgeの新しい記録はcc_nudge_deliveryで、AI活動・子/審査状態変化で再評価する。
  共通wait判定はWSへのPTY配送直前に適用し、Revisor通知などの観測イベントを捨てない。
  新しい対人確認要求はsourceのhuman-confirmation意図を区別し、自己的な待機gateで消さない。
- 採用snapshotはmodel_role_snapshots、履歴はmodel_role_history、日次leaseはmodel_refresh_days。
  `GET /v1/model-catalog/roles/:provider/:role` はschemaVersion=1とUTC ISO時刻を返す。
  PATCHはexpectedRevision付きpin変更、POST .../rollbackは過去revisionへの明示切替。
  GET .../refresh-statusで調査失敗/能力不一致/未対応providerの理由を表示する。
  標準Solテンプレの追随はdelegation_model_followingをdelegation側portが所有する。
  modelを明示PATCHした時点で同じIDでも追随解除する。旧既定6から6.1だけ移行し任意pinは保持。
  Solはmedium/xhigh両方の能力が確認できた安定同一familyだけ採用する。
  bootstrap出典はconfiguredでありfresh公式取得成功とは区別する。
  公式取得はnative codex executableまたはnode+公式entrypointのみ、shell shimは拒否する。
  個別設定はCONCORDIA_CODEX_MODEL_CATALOG_EXECUTABLE。認証はCodex自身が所有する。

テストコードを同じ変更単位で追加し、Ccはcc.acceptance.jsonと必要なaugur.contracts.jsonへ登録する。
2026-10-03に人間が今回Cc範囲の単体・統合・in-memory migration検証を「許可」と明示した。
サービス起動・再起動と実provider通信は今回未実施。Lapilliは別セッションのテスト通知待ち。
特に常駐再利用の実機検証は同一child session/threadが2依頼で維持される証拠を必要とし、
キャッシュhitや費用削減の保証はしない。

受入: LIFE-01〜04、WAIT-01〜03、MODEL-01〜07それぞれに正常・失敗・競合/再起動のテスト。
SolはCc/Lapilliを専用worktreeで順に仕上げ、PRはrepo別。親が設計採否と統合を担当する。
現在Ccのモデルガードが6固定のため、修正用Sol6.1は内蔵の継続可能セッションを使う。
同じ子にfollowupし、タスク報告ごとに新規子を起動しない。修正後の正規Cc経路と同一視しない。
WebUI作業は本件の対応・確認後に既存ActioとPR #2329から再開する。

### 実装と受入テストの対応

| 受入 | 対象テスト（Cc側は下記最新checkpointで実行済み） |
| --- | --- |
| SC-LIFE-01〜04 | src/delegation/sidecar/lifecycle.test.ts、既存run-watchdog/finished-run-reaper/teardown-ladder tests |
| SC-WAIT-01〜03 | src/control/automatic-continuation-policy.test.ts、nudge-delivery.test.ts、human-response-confirmation.test.ts、stalled-session-nudge.test.ts、src/api/ws-continuation.test.ts、src/taskflow/decompose-inject.test.ts |
| SC-MODEL-01 | src/delegation/sidecar/profile.test.ts、gate.test.ts、invoke-guard.test.ts、src/delegation/seed.test.ts、src/model-catalog/seed.test.ts |
| SC-MODEL-02〜05 | src/model-catalog/role-policy.test.ts、refresh.test.ts、codex-provider.test.ts、http-port.test.ts、tests/model-role-api.test.ts、src/db/migration-ledger.test.ts |
| SC-MODEL-06〜07 | Cc側のstructural portはhttp-port.test.tsで照合。Lapilli側async/同期互換テストは後続Lp実装の担当。 |

既存CLIのstatus bodyにresident_generationは追加任意。明示値は照合し、不一致を拒否する。
現在依頼はCc所有resident receiptのrun UUID/generationで照合し、旧terminal runの遅延報告は旧runの重複として扱う。
二件目はsession metadataのdelegation_run_id/call_nameを更新してinquiry/read-modelのcurrent pointerを揃える。
初回enrollment環境は上書きできないため、新規sealed promptに現在の報告run IDを含める。
WS配送直前のgateは観測イベントを捨てない。decompositionの永続inject記録はgateを確認してから保存する。
### 実行許可以前の静的checkpoint（履歴、2026-10-03）

Backend TypeScript型確認は成功。Test TypeScript型確認は既存の二件のみ失敗:
`src/api/sessions/startup-policy-check.test.ts:50` と `tests/usage-budget-spawn.test.ts:27` の `claude` / ProviderName不一致。
両ファイルはbase `d13fe62d` とのgit diffおよびworking statusが空で、本変更では編集していない。
単体・統合テスト、provider subprocessの実通信、migration in-memory実測、build、サービス操作は未実行。
新migration125の静的checksumは凍結台帳へ追加したが、SCHEMA_FINGERPRINTは旧値のまま。
許可回答後にin-memory SQLiteのschemaFingerprintを実測して更新し、migration-ledger回帰を実行する必要がある。
従って本checkpointは実行検証前であり、PR提出・本番反映の準備完了を意味しない。
配送共通gateのbindingMatchesはcompositionでtrueとしており、共通gate自体はbinding変更を取得・検証しない。
既存producerの対象binding再照合（stalled-session-nudge等）へ責務を残す。純関数のfalseケースは
ポリシー単体の受入であり、全producerがbinding再照合済みという実配線の証拠ではない。
parent lostは一時接続喪失として既存childと結果を保持し、新規followupだけをactive条件で抑止する。
### 実行許可以前のResidual follow-up境界（履歴）

`src/taskflow/residual-binding.ts` is a pure policy within existing
 taskflow-instructions membership. It snapshots work-target identity and requires
 unchanged active session/repository/origin/branch/subsidiary/task/project/team/department
 after each TaskStore await. `residual-blackbox` owns procedure and latest wait checks.
Confirmation delivery is checked before claiming the latch or recording inject/phase.
A refused confirmation returns waiting with no latch, inject record or residual phase.
Tests: residual-binding.test.ts, residual-blackbox.test.ts, and mock-only
 attachWsServer delivery/TaskflowRuntime review-dispatch in ws-continuation.test.ts.
No real HTTP/WS server or test process is started by static verification.
Residual/WS follow-up static checkpoint: backend tsc passed; test tsc reports only
 the same two untouched ProviderName errors noted above. git diff --check exited0.
The new/changed residual and mocked WS tests were not executed. Mocked review
 dispatch checks receipt at TaskflowRuntime's subscriber; it does not claim PR/Actio
 state transitions were integration-tested. Schema fingerprint remains unmeasured
 and unchanged. Lapilli checkpoint eb4e459 remains stopped pending a separate
 session's test notification; this Cc follow-up does not edit or execute Lapilli.
### 許可後の検証checkpoint（main統合前、2026-10-03）

変更sourceに対応するcc.acceptance全行のtests和集合62filesを実行し、
504 testsが合格した（重複再実行を除外）。当初seed期待値の旧Sol6が1件失敗し、
6.1へ修正してseed44件とresident11件を再実行、55/55合格。
新規12files60件、既存13files175件、残37files264件と、追加parent競合5件を含む。
実provider通信・実サービス起動は行っていない。WSはmock transportで観測者と
TaskflowRuntime審査subscriberへの通知保持、配送抑止を検証した。
resident followupはprepareRequest await後にparent activeとrepository/origin/branch/
subsidiary/task/projectを再照合する。変更時は新run/receiptへ理由付き失敗を保存し、
配送とchild metadata変更を行わず、旧成果と再利用可能なchildを保持する。
ended/lost/repository/branch/subsidiaryの検証待ち中変更5ケースが合格。
migration125はin-memoryで85 ledger rows、fingerprint
`f5d8875b92d78d21d8fa87c342cd2b2a512029c99181deffc31f60f615e90275` を実測し、
ledger7件が合格。mainにも125が追加されたため、この値は統合前の証拠に限る。
featureをlocal mainへrebaseし今回migrationを126へ移した後、再実測する。
Augurの追加14契約は定義登録済みだが、runtime観測による独立実測は未実施。
Lapilli eb4e459は停止保持し、この検証では編集/実行していない。
### main統合後の検証（2026-10-03）

local main `1fa83add` へfeatureだけをrebaseした。mainのmigration125
`usage-budget-discord-role-multipliers` を変更せず、今回のresident/model migrationを126へ分離した。
既存Augur契約も全て保持。125のmigration blockはCRLF差を除きmainと一致することを照合した。
126のversion/name/source checksumを再計算して凍結台帳へ保存:
`8dcd62253650fcc5651a8d8432716866cfe6e7ddd387bf41fdb86b0cd14f1102`。
全migrationをSQLite :memory:へ適用しledger86rows、schema version126、fingerprint
`7c2c8edc6c5579c06795fb9cbff38b54b06f2a0ccf12ab6981cbe5ece63a2a83`
を実測しSCHEMA_FINGERPRINTへ保存した。実測は既存schemaFingerprint/runMigrationsで行い、
本番DBや稼働サービスへは接続していない。
main125関連のusage-budget-multipliers-repo/budget-role-multiplier 2files9testsは合格。

登録62files一括実行はRUN表示後約5分無進捗で停止し、合格扱いにしていない。
所有PID77928のみ終了し、直接子プロセス0を確認した。既存VitestのsingleThread/
isolate:false構成を変えず、先に合格した12/13/37filesへ分割して再検証した。
一括停止の原因は未確定で、既存combined native終了課題と同一とは断定しない。
Backend tscは合格。test tscは従来のProviderName不一致2件のみ残る。
両ファイルは統合後mainともdiff無しで、本タスク外の修正は行わない。
追加Augur14契約のruntime観測、本物のCodex app-server通信、同一childの実機継続、
実サービス起動/再起動、cache hit/費用削減の測定、buildは未実施。
この記録はローカル検証であり、PR提出・merge・反映済みの証拠ではない。
最終結果: 統合後も変更source（test/contractを除く）に一致する
`cc.acceptance.implementations` 全行（重複sourceを含む）のtestsを重複除去し62files。
新規群12files65tests、既存境界13files175tests、登録回帰37files266tests、
計506/506合格。mainの追加回帰2件により統合前504から506へ増えた。
main125関連の別2files9testsを合わせ64files515tests合格。
分割の実行時間は8.18秒、17.68秒、271.08秒（37files）と1.53秒（125関連）。
全て `node node_modules/vitest/vitest.mjs run <登録対象群> --silent` を使用し、
統合後の分割はverbose reporterで個別進捗も確認した。
対象抽出は `git diff --name-only main -- src` の実装sourceと上記登録の完全一致に基づき、
無関係な全量suiteへ拡大していない。migration-ledger7件も合格し、凍結checksum・
実schema fingerprint・migration適用整合を検証した。
未実施は上記実機/独立runtime観測/サービス操作/Lapilli、一括完了も未確認のまま。
### Revisor #2352の所見と追補（2026-10-03）

Revisorのhead6c963cb4審査はdelegation-launch domainの既存
`src/delegation/service.test.ts` 1fileが失敗。Augur run
`r-20261003072826712-b42c1d93` は117952ms、Vitest file assertions合計108839ms。
STACK_TRACE_ERRORのtask定義stackは188行の外部設計md同梱ケースを指す。
インストール済みVitestのmakeTimeoutErrorが定義時STACK_TRACE_ERROR stackを
割り当てる実装と一致し、個別テストのdeadline発火が疑われる。
当該ケースのtimeout指定は無くVitest既定5秒、Augur runnerは600000ms。
本文/setupは本変更で未編集、memory DBとtemp fixture、spawn stub999を使用する。
実provider通信やdomain preamble通信は既存test setupで無効化されている。
手元分割では当該ケース256msで合格したが、Revisor scratch環境での再現は未実施。
別のGit worktree2ケースは各39374/41475msで合格し、188の失敗と分ける。
全体timeoutを増やしたり、台帳登録だけで失敗を解消したとは扱わない。
他sessionのtesting claim競合中なので、再現テストは正規claim取得後に限定する。

非blockerのmodel-catalog登録不足はcc.acceptanceのsource/tests対とは別に、
`.augur/tests.jsonl` の正規test台帳が新domainを持たなかったことを照合した。
台帳ファイルは既存tooling.domain所属。test所属の正本はmodel-catalog.domain.json。
Augur tests registerでrole-policy/refresh/codex-provider/http-port/seedおよび
model-role-apiの計6filesをmodel-catalog business/programへ登録済み。
seedは既存analysis-core所属から正本の移管に合わせ更新し、登録APIが履歴を保持する。
台帳JSONの手編集は行わず、register後lintはvalid、listで6件activeを確認した。
追加契約の独立runtime観測未実施は変わらない。登録の追補と審査失敗再現は別の証拠。
競合解消後の再検証: 同梱ケースのみを `-t "明示された別リポ md"` で選び、
verboseとJSON reporterを併用して診断を保存した。1passed/54skipped、
当該790.7781ms、suite4.07秒で合格し、元の失敗は再現しなかった。
診断原本は `%TEMP%/cc-2352-isolated.json` と同名.log。製品コード・test timeoutは未変更。
従ってこれは再現不能の確認であり、根本原因を修正したという主張ではない。
model-catalogの正規Augur `domain:model-catalog --no-promote --head 6c963cb4...` は
run `r-20261003075102316-bcb9ff42`、10060ms、6records全passed。
登録認識と実行を照合し、単なる台帳追加による合格扱いはしていない。
An/Ex/サービス操作とLapilli操作は行っていない。
正規 `domain:delegation-launch --no-promote --head 6c963cb4...` の一回再実行は
run `r-20261003075133388-1b109dcc`、128772ms、file-level1record全passed。
対象は既存service.test.ts全55assertions。元失敗が再現せず、原因未特定のまま。
元失敗runを上書き/削除せず再検証runと区別する。十分な局所診断を保存した後の
再試行合格であり、製品原因修正やRevisor再審査通過の証拠とは同一視しない。
この追補は台帳と仕様のみでsource/test code変更が無いため、既に正常の同対象を
不要に全量再実行せず、親へ再審査判断を引き継ぐ。
mainはa2e6b63bへ進行したが相談profileの6filesのみ。今回の追補とschema126に
直接競合はなく、検証fixtureは6c963cb4を固定した。mainやサービスは変更していない。