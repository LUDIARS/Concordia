---
task: domain-review-anatomia-gates
project: Concordia
kind: 実装
created: 2026-09-05
memory_links: []
---
# ドメインレビュー PR の Anatomia ゲート所見を解消する

対象は `feat/domain-review-discord` (Revisor local PR #1405)。
機能そのもの (設計書 `2026-09-05-anatomia-domain-plan-tool.md` §8 C-3〜C-6) は変えず、
Anatomia の審査ゲートが挙げた所見だけを潰す。

## 目的

`anatomia pr-review` の 5 ゲートと二層 (dual-layer) 判定を、人間のバイパス無しで
通る状態にする。提出時点で落ちていたのは次の 3 点。

1. **spec_linkage (14 anchors)** — `src/domain-review/plan-file.ts` の全関数と、
   `web/src/pages/ProjectCodes.tsx` の無名関数が spec 節に紐付いていない。
   `.anatomia/plan/<hash>.json` の読み書き契約が spec に書かれていなかったのが原因。
2. **convention_drift (1 anchor)** — `src/config/service-urls.ts` の `validPort` が
   兄弟 (`...BaseUrl` 群) の命名から外れている。中身はポート番号を返すので名前は正しく、
   置き場所の方が誤っている。
3. **dual-layer 126 anchors unclassified** — `.anatomia/layers.json` に
   `src/domain-review/*` の層宣言が無い。

## やること

- `spec/feature/domain-review-discord.md` に §4.1 (plan ファイルへの追記契約、
  clause id `SPEC-DOMAIN-REVIEW-PLAN-FILE`) と §7 (実装の配置) を足し、
  `plan-file.ts` から `@implements` で結ぶ。§1 で WebUI 側のファイルを名指しする。
- `validPort` を env 文字列の解釈を持つ `src/config/env-parse.ts` へ
  `readPortEnv(raw, envKey)` として移す。兄弟集合が「env パーサ」になり、
  嘘の名前を付けずに乖離が解消する。対の単体テストを env-parse 側へ足す。
- `.anatomia/layers.json` に `src/domain-review/*` = `domain-logic` を宣言する
  (`src/inquiry/*` / `src/model-review/*` / `src/pr/*` と同じ扱い)。

## 完了条件

- [ ] `anatomia pr-review --repo <worktree> --base <main>` の 5 ゲートが全て pass。
- [ ] dual-layer の `unclassifiedAnchors` が 0、`pass: true`。
- [ ] `tsc --noEmit` (src / test) と dependency-cruiser が通る。
- [ ] 触れたテスト (`src/config/env-parse.test.ts` / `src/config/service-urls.test.ts`) が通る。
- [ ] C-3〜C-6 の機能面の振る舞いを変えていない (追加・削除した実装が無い)。

## 再利用探索の採否

- `isRecord` — `anatomia find` / grep で Concordia 内に 8 コピー
  (`api/tasks.ts` / `control/goal-and-go.ts` / `federation/protocol.ts` /
  `harness/blackbox-engine.ts` / `shared/event-schema.ts` と domain-review の 3 本)。
  **どれも export されておらず、ファイルローカルの述語というのがこのリポの既存の書き方**。
  domain-review の 3 コピーを 1 本へ寄せる案を実際に試したが、
  `coupling_delta` が新たに落ちた (`appendPlanReviewAnswer`: coupling=18 > p95=15)。
  共有ノードへ fan-in を集中させると、その利用側の結合度が repo の上位百分位を超える。
  `duplication` ゲートは通っており、寄せる必然性が無いので **採らなかった**。
- `normalizePath` — 同様に 6 コピー。今回の変更対象外 (既存の広がり) なので触らない。
- ポート文字列の解釈 — `src/config/env-parse.ts` が「env 文字列 → 型付き値」の正本として
  既にあるので、新しい置き場所を作らずそこへ足した (**採用**)。

## Anatomia が挙げた orphan 12 件について

`quality.changedOrphans` は 12 件残るが、**すべて呼び出し元がある誤検知**である。
Anatomia の orphan 判定が辺にできていない参照の形が原因なので、コードは削らない。

| 関数 | 実際の参照 |
|---|---|
| `startBackend` | `src/server.ts` から呼ぶ起動口 |
| `DomainReviewRepo` の constructor / `findAnswerBySource` / `markAnswerPlanAppended` | `src/domain-review/service.ts` からのメソッド呼び出し |
| `AnatomiaDomainClient` / `DomainReviewService` の constructor | `src/bootstrap/core.ts` の `new` |
| `coreDomainLine` / `relationLine` | `report.coreDomains.map(coreDomainLine)` — 関数値としての参照 |
| `normalizeEmbed` | `embeds.map(normalizeEmbed)` — 同上 |
| `captureLayerDiagram` | `this.deps.captureImage ?? captureLayerDiagram` — 既定値としての参照 |
| `EditableRow` / `ProjectCodes` | JSX 要素 (`<EditableRow />`) と `web/src/App.tsx` の Route |

## main との衝突解消 (再提出 2 回目)

ゲートを 0 にした後、 main が先に進んで Revisor が `action_required` (9 ファイル衝突) を返した。
機能は一切変えず、 取り込みだけを行った回の記録。

### migration の採番衝突

main と本系統が version 89 / 90 を同時に取っていた。 **main 側を動かさず、
本系統を 91 / 92 へ振り直して後ろに並べた**。 どちらも捨てていない。

| version | 採番後 |
|---|---|
| 89 | `github-issue-workflow` (main) |
| 90 | `github-issue-run-author` (main) |
| 91 | `project-code-domain-review` (本系統、 旧 89) |
| 92 | `domain-review-posts` (本系統、 旧 90) |

`SCHEMA_VERSION` を 92 へ、 `FROZEN_MIGRATIONS` の 91 / 92 の checksum と
`SCHEMA_FINGERPRINT` を実装から取り直した (checksum は version を含むので採番変更で必ず動く)。
`spec/feature/domain-review-discord.md` §1 の「migration 89」も 91 へ直した。

migration が実際に流れることは、 90 まで進めた DB に 91 / 92 を後から当てて確認した。

- `github_issue_workflow` 列は残り、 `domain_review` 列が足されて seed が流れる。
- 人が `/projects` で 0 に切った後に 91 / 92 を再度流しても **1 へ戻らない**
  (「列を追加した回だけ流す」ガードが効いている)。 `domain_review_posts` も作り直されない。

### 列を足した 7 ファイル

`project_codes` へ両側が別々の列を足した形なので、 **両方の列を残した**。
`ProjectCodes.tsx` は列が 10 本になったので注記の `colSpan` を 5 へ、 空表示を 10 へ揃えた
(基底の 2 は元から 1 ずれており、 main 側はそのずれを引き継いで 3 にしていた)。

`src/github/authorization.test.ts` (main のファイル) は `ProjectCodeRow` が
`domain_review` を要求するようになったため fixture に 1 行足した。 これで main の
`src/github/` が diff に入り、 二層判定に未分類 9 anchor が出たので
`.anatomia/layers.json` へ `src/github/*` = `application` を宣言した
(layers.json 自身が「unclassified 0 を保つ」を不変条件として掲げている。
Issue → 委託 → 審査 → GitHub PR を 1 本の状態機械として回す層なので、
`src/workflow/*` / `src/taskflow/*` / `src/release/*` と同じ扱い)。

### 検証

`main` = `8aa40537` を基点に取り直した結果。

- `anatomia pr-review` 5 ゲート全て pass、 `hasTargetDomain` true、 `unassignedAnchors` 0、
  二層判定 `unclassifiedAnchors` 0 / `pass: true`、 spec 側も `pass: true`、
  `changedViolations` 0。
- `tsc --noEmit` (src / test) と `web` の `tsc -b`、 dependency-cruiser (1208 modules) が通る。
- 衝突を解いたファイルに対応するテスト 11 本 77 件が緑。
- `changedOrphans` は 11 件 (前回 12 件から `findAnswerBySource` が外れた)。 上の表のとおり
  すべて呼び出し元のある誤検知で、 コードは削っていない。
