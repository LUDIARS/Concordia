# Cc workload 境界の実装

参照: actio:925ce186-9892-487a-b8e0-5225f2c04ec2（本文は複製しない）。親参照: actio:7a9649fb-f582-4082-b841-922ba798139b。
仕様: [cc-workload-security](../feature/cc-workload-security.md)。契約 C-21〜C-24 は今回追加分、既存契約と分けて報告する。

- [x] 既存 federation/HTTP 所属、再利用境界、価値・不変条件を定義
- [x] Augur plan を生成（2026-10-07-cc-workload-test-plan.json）
- [x] 契約を先行追加し、Cr adapter・proof・永続 nonce・認可 use case を実装
- [x] 連合送受信、HQ変更、ブラウザ境界へ配線
- [x] 対の回帰テストと移行仕様を追加、許可後の隔離43/43成功
- [ ] Concordia commit 依頼、正式な提出経路確認、local PR 提出
- [ ] 契約集計と委託status報告（acceptance/merge未確認ならpartial）

## 初回検証記録（隔離実行許可前の履歴）

- 製品 TypeScript `tsc --noEmit -p tsconfig.json`: 通過。
- テスト TypeScript: 変更外5件で不通過（startup-policy-check、consult-fetch-link、safety-runtime、chores、usage-budget-spawn）。テスト本体は未実行。
- Augur inject: 新規4件注入。既存55件の orphaned 警告は変更しない。生成 import は本repoのNode16規約に合わせ `.js` に補正し、既存observe runtimeを再利用。
- Augur contracts lint: 新規4件の指摘0件、全体82契約中既存9件の指摘。
- Augur acceptance: C-21〜C-24 は各 calls=0、observed=0、violations=0、met=false。DELEGATION_STARTED_AT未注入のためCc runのcreated_atを期間始点として使用。
- `git diff --check`: 通過。
- Cr相互接続、TLS実接続、テスト、起動・再起動、稼働設定変更、マージは未実施。

## 残る移行境界

Cr側の ai-spawn/ai-inject/thread grant語彙と、Ex→Cc HQ変更callerの新proof移行は実装済み。共有の合成wire fixtureでCr発行claimsと両adapter/proofの互換を確認した。既存Actio参照を保持し、受け入れ・マージ未完了のため正本タスクを完了へ変更しない。

## 2026-10-07 許可後の隔離検証

- cc-test claim/release付きで security5files / federation runtime-security / transport-policy / API federation / local-browser-policy の9suite43/43成功。fakeHTTPとin-memory SQLiteのみで実サービス・LLM・production DBを起動しない。HQ deny/missing configでupdateSiteゼロeffects、署名・失効・永続nonce・要求重複排除、遠隔不可のlocal fallback拒否を確認。
- isolate:falseのmodule cacheによりruntime-security先行時にmock前のruntime importを再利用する順序依存3failを観測。security/runtime fixtureをresetModules後のdynamic importに修正し期待値を維持。shuffle seed1で問題順序の5/5と最終9suite43/43を再確認。
- observe runtimeはtestでJSONLを無効にするためscratch reporterでprocess-local counterを保存。module reset後のsnapshot C-21:18 / C-22:17 / C-24:17、別browser-only run C-23:16、全violations/predicate_errors0。fixture再初期化前を含む総call数や運用期間の受入集計とは扱わない。証跡 .tmp/security-regression-20261007/{federation,browser}-contract-metrics.json。
- production TypeScript成功。test全体TypeScriptは初回と同じ変更外5件の既知エラーで失敗、今回runtime fixtureのエラーはない。git diff --check成功。
- scratch共有wire harness .task-tmp/security-wire-regression-20261007.mtsで5recipient-scoped issuance flow成功。実Cr authority+Ex token/introspection/proof adapter+Cc introspection/request authorizationをmockHTTPS21callで接続し、ai-spawn/ai-inject/HQ(Cc宛)/vault/HQ(Ex宛)、wrong audience、本文改変、発行後grant失効を検査。tokenは実行時生成dummy、実鍵登録/外部通信なし。
- UX-CC-W1/W2/W5、S1/S2/S3/S6、CC-INV-02/03/07と既存federation/http-interface所属を維持。稼働TLS/停止途中副作用/実機UX/運用cutover/一般管理API利用者credentialsは未検証または未解決。正式PR提出と審査/mergeは親が既存結果照合後に担当。

## 最新main統合と受入対応

- ローカルmainを8836bc5で競合なく統合し、mainのsite起動/担当プロジェクト機能を保持。spawn.tsの逆差分を解消し、変更していないsourceへmappingを捏造しない。
- cc.acceptance.jsonへ各security/browser sourceと実テストの対応を追記。configの実検証がmock fixtureに不足していたため2件追加し、distinct Cc identity / HTTPS / file256KiB bound / missing credentialを検証。appの既存404検査へ明示Hostを追加し、実app guardから管理startOneが0となるケースを追加。
- main統合影響範囲17suite98/98成功。追加変更後config/app/runtime-security7/7、SettingsStore fixture修正後forum-site-tags/app8/8成功。forum-site-tagsのdegrade ECONNREFUSEDログはfakefetchが生成するもので、実通信を示すものではない。
- inspectCodeAcceptance（ddd:true/testsRequired:true）は21sources/missing[]/ok:true。構造検証のexecutionはnot_checkedで、実テスト証跡と区別する。production型検査成功、test全体型検査の変更外既知5件は継続。

## 必須型・依存ゲートの継続対応

- 既知5件の型エラーはcanonical provider名、実in-memory SessionsRepo fixture、typed Discord send mock、既存fetch-link commandの正確な宣言で修正。相談domain宣言へ.d.mts所属と実test対応を追加。usage-budget API fixtureは実Host境界を通す明示Hostを追加し、成功/予算拒否の期待値を維持。対応6suite36/36成功、test全体TypeScript成功。
- 今回observe predicateからwrapped sourceへの逆type import4循環を、純粋な観測input shape/共有BrowserInput型へ分離。判定式は維持。security/browser7suite33/33成功。
- inspectCodeAcceptanceのDDD/tests構造検査は追加純粋型・宣言を含めmissing[]。check-src-emitted成功。dependency-cruiserは今回4循環解消後も既存/最新main由来13errorsが残るため、必須lint全体は未通過として親側へ報告。除外やgate無効化はしない。正式PR提出はこの未解消gateを保持して保留。

### 必須 lint の依存境界修正（受入継続）

既存の PR DTO、ハーネス述語型、相談/フォーラム入力型、対話フォーマット型、役職指示の純粋処理、役割一覧 DTO を各既存 domain の下位モジュールへ抽出する。モデル提案の純粋処理は agent-delegation が所有し、旧 Discord export を維持する。公開型、判定式、Augur の公開 wrapper は保持する。既存 PR・述語・相談/起動・対話・役職指示・モデル/役割一覧の mock 回帰と既定 lint で検証する。除外や期待値緩和は行わない。

検証結果: 関連19 suites / 193 tests PASS（既存 mock / in-memory 回帰、旧 export 経由を含む）。既定 npm run lint は check:src-emitted、production/test TypeScript、dependency-cruiser 全 PASS、2143 modules / 8132 dependencies の違反0。DDD/testsRequired の inspectCodeAcceptance は ok:true / missing:[]（構造検査であり実行結果は上記の別証跡）。サービス起動・配備・実運用移行は未実施。

### PR2530 の fixture 修正と正本検証の訂正

審査 head 2179589d の setup/bootstrap は成功。Augur の実 failed を read-only の runs 記録で照合し、7 domain の 41 failed 記録（同一 file の重複あり）を確認。通常相対 app.request の Host 不足による 403 と、その拒否応答の payload を読む二次例外である。共通 test app は相対 path の通常要求だけ localhost Host を補完し、明示 Host・Request・絶対 URL は保持する。製品 guard の変更、テスト削除、期待値緩和は行わない。新規 helper 回帰では通常成功、Host 空値/敵対・Origin 敵対・明示 Request/絶対 URL の Host 不足を検証し、拒否時の書き込み0を確認する。

PR2530 に残る古い『43 tests / 5 type errors』説明と文字化け追記は現状を表さない。現 head の実測は本 task の最新検証を正とし、親が保持する UTF-8 訂正文を再審査根拠とする（同じ PR の本文更新 API が未提供のため、重複提出しない）。

実 caller の最小追補: http-interface domain の既存 membership web/src/[^/]+ と cc-workload-security に従い、web/src/api.ts の DELETE 共通 helper は本文無しでも application/json を明示する。post/put/patch は既に JSON header を送る。web/src/api-request.test.ts の fake fetch→in-memory app 回帰で実 caller の要求生成と guard の正常受理・書き込みを照合する。旧クライアントも本文無しの変更要求に明示 Content-Type 対応が必要であり、互換移行残件として扱う。

最終 fixture 回帰: 元の全失敗36 files と新規 helper 1 file の 37 suites / 279 tests PASS。Host 修正後に残った body 無し変更要求の 415 は、6 test files が JSON Content-Type を明示することで解消。skills refresh の拒否に伴う空 catalog / PUT 400 も解消。実 web caller の DELETE / staff 削除 fake fetch 回帰、helper 8件、既存 browser policy 13件を合わせた追加3 suites / 22 tests PASS。失敗 assertion の削除・期待値緩和なし。旧 client の変更要求 JSON ヘッダー対応は、実運用移行の残件として引き続き明示する。

追補後の既定 npm run lint 全 PASS（production/test TypeScript、check:src-emitted、depcruise 違反0 / 2143 modules / 8132 dependencies）。DDD/testsRequired の構造 acceptance ok:true / missing:[]、testing claim release1 を確認。ライブ service/LLM/配備は未実行。
