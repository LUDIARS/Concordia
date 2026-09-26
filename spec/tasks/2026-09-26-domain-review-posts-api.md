---
task: domain-review-posts-api
project: Concordia
kind: 実装
created: 2026-09-26
reference: actio:6ba17203-9178-4c4b-90cf-a57a3a6f51f6
source_session: lictor-5af8d951-a190-4e27-9b65-6e660ee13600
memory_links:
  - spec/feature/domain-review-discord.md
---
# ドメインレビュー投稿の一覧 API を追加する

### 目的
Breviarium が「定期: Pf UX 準拠レビュー」段の完了を判定できるよう、プロジェクトごとの
ドメインレビュー投稿の日時と規模を読み取り専用で返す (spec/feature/domain-review-discord.md §8)。
これまで Cc には `GET /v1/domain-review/posts/:id` しか無く、一覧を引けなかった。

### 価値と不変条件
- 価値 ID: UX-CC-W4 (シナリオ S5) — 通知や状態を見れば、今必要な判断 (定期レビューが済んだか) が分かる。
- CC-INV-04: 見送り (`posted: false`) と投稿失敗は台帳に残らないので一覧にも出ない。投稿していないものを投稿済みに見せない。
- 読み取り専用: `GET /posts` は台帳・plan・Discord のどれにも書き込まない。
- 本文を返さない: レポート全文・層図の画像・Discord message 本文・plan の問いの本文・channel / message id は返さず、規模は件数だけで表す。
- 件数を推測しない: migration 111 より前の投稿の出所・件数は null を返し、0 で埋めない。

### 変更した境界
- HTTP: `GET /v1/domain-review/posts?code=&limit=` (`src/api/domain-review.ts`)。limit 既定 20・上限 100、code は大文字小文字を区別、未知の code は空配列。
- 読み取り use case: `src/domain-review/post-listing.ts` (件数上限の解決と、本文を含めない要約への射影)。Augur observe 契約 C-10 / C-11 (`augur.contracts.json`、述語 `post-listing.contract.ts`、runtime 再公開 `ontime-runtime.ts`)。
- 永続化: `DomainReviewRepo.listByCode(code | null, limit)` と、投稿時の件数保存。`repo_origin` は project_codes から JOIN で引き、投稿行へは複製しない (origin の正本を 2 つにしない)。
- スキーマ: migration 111 `domain-review-post-summary` (`report_source` / `core_domain_count` / `layer_count` / `layer_violation_count` 列と `(code, created_at DESC)` 索引)。凍結台帳 (`migration-ledger.ts`) と SCHEMA_VERSION を更新。
- 投稿処理: `DomainReviewService.request` が投稿したレポートの件数を台帳へ渡す。

### 再利用探索
- 採用: `src/db/list-limit.ts` の `clampListLimit` (一覧系共通の丸め規則) に上限 100 を重ねた。空・非数値・負値の扱いを他の一覧 API と揃えるため。
- 採用: `parsePostQuestions` (壊れた JSON を空として読む既存規則) で問いの件数を数える。
- 採用: `src/deploy/ontime-runtime.ts` と同じ形の runtime 再公開で、既存の observe 専用 `contract()` を使う。
- 不採用: Anatomia plan の exemplar `buildDomainReviewReport` は投稿用レポートの組み立てで、一覧の読み取りとは責務が違う。

### 復旧方法
- migration 111 は列と索引を足すだけで、既存の投稿行は書き換えない。列が既にあれば足さないので途中停止後の再適用でも壊れない。
- 旧コードへ戻した場合も、追加列を読まないだけで投稿と返信の取り込みは変わらない (列は残るが無害)。
- 並行 PR が migration 111 を先に使った場合は、マージ順に番号と凍結値 (checksum / SCHEMA_FINGERPRINT) を振り直す。

### 検証
実施:
- `tsc --noEmit -p tsconfig.json`: エラー 0。
- `tsc --noEmit -p tsconfig.test.json`: エラー 3 件。いずれも本変更で触れていないファイル (`src/api/work-submission-routes.test.ts`、`src/discord/image-inbox.test.ts`、`tests/ontime-runtime.test.ts`) の main 既存エラー。
- vitest: `src/db/domain-review-repo.test.ts`、`src/api/domain-review.test.ts`、`src/domain-review/post-listing.test.ts`、`src/domain-review/service.test.ts`、`src/db/migration-ledger.test.ts`、`tests/schema.test.ts` = 6 ファイル 82 件成功。
- 回帰: domain-review ドメインの残りの登録テスト (embeds / post / anatomia-client / embed-limits / plan-file / report / seed) と `src/discord/ingress.test.ts` = 8 ファイル 78 件成功。
- dependency-cruiser: 違反 1 件は本変更外 (`src/delegation/internal-agent-policy.ts` → `src/discord/forum-model-suggest.ts`) の既存違反。新規の依存違反なし。
- Anatomia `pr-review --repo <worktree> --base 642f6539`: verify.pass = true (rule_conformance / duplication / spec_linkage / coupling_delta / convention_drift すべて pass)、dual-layer pass、spec 未リンクの変更ファイル 0、changed orphan 0。
- Cc 受入ゲート (`checkCodeAcceptance`、DDD + tests_required) を手元で再現: 変更した実装 7 ファイルすべて ok。
- Augur contract-wrap: C-10 / C-11 を `applied` で注入。vitest 外での 1 回の実行で `contract observed` (違反 0) を確認。

未実施:
- サービスの起動・再起動を伴う動作確認 (委託範囲外)。
- Augur の `contracts report` は `VESTIGIUM_LOGS_DIR` 直下の `*.jsonl` だけを集計し、Cc 本体の observe イベントが書かれる `logs/concordia/` を読まない。そのため C-10 / C-11 は実行済みでも集計上は未観測になる (src 配下の既存契約 HR-* / C-1〜C-7 も同じ状態で、本タスクの範囲外)。

### 完了条件
- `GET /v1/domain-review/posts` が投稿を `posted_at` 降順 (同時刻は id 降順) で返し、limit は既定 20・上限 100 に丸める。
- code 指定時はその code の投稿だけを返し、未指定は全プロジェクト、存在しない code は空配列を返す。
- 応答は id / code / repo_origin / trigger / source / posted_at / core_domains / layers / layer_violations / plan_questions の 10 項目だけで、本文・画像・Discord message 本文を含まない。
- repo (順序・limit・code 絞り込み) と API (200・limit 上限・本文を含まない) のテストが通る。
- typecheck と対象テストが通り、Anatomia verify が pass し、Revisor local PR を提出する。

### スコープ (編集可ディレクトリ)
Concordia の src/api、src/db、src/domain-review、spec/feature、spec/tasks、cc.acceptance.json、augur.contracts.json、.augur。
