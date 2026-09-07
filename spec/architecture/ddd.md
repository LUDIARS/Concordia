---
title: Concordia の DDD 実装方針
type: feature
id: CC-DDD-POLICY
service: concordia
domain: session-coordination
status: draft
owner: engineering-owner
---

# Concordia の DDD 実装方針

2026-09-07 の「今後 DDD でコーディングする」という依頼に基づく開発方針。
DDD の適用は今後の新規実装・変更箇所から始める。以下の分類や詳細設計は、既存の業務責務から
整理した案であり、Pf 上で人間が承認した境界や、全コードの移行完了を主張するものではない。

## 目的と正本

利用者の問題・価値は [プロダクト UX](../ux/product.md)、各機能の挙動は `spec/feature/`、
コード所属は `spec/domains/*.domain.json`、保存契約は `spec/interface/` と `spec/data/` が所有する。
DDD はディレクトリ名を揃える作業ではなく、業務用語・状態・不変条件の所有者を決める作業とする。

Pf/An が読む UX 文書は同じ `spec/ux/` を参照し、別 DB に編集可能な目的のコピーを作らない。
文書 ID と価値 ID は安定させ、名称変更でも保持する。承認は文書の内容版に紐付け、draft の作成や
機械検証を人間承認として扱わない。画面・チャットチャンネル・シーンの配置だけから業務境界を導かない。

## 戦略的な分類と既存コードへの対応

現時点のコア候補は **session-coordination** と **agent-delegation** の 2 つ。
複数 AI の状況を共有して途中停止から仕事をつなぐこと、仕事を分担して成果を追跡することが
Cc の価値を直接決めるためである。名前に `core` が付くことやコード量だけでコアに分類しない。

| 分類案 | 既存ドメイン/責務 | 所有する判断と境界 |
|---|---|---|
| コア：セッション協調 | session-coordination | 対象・担当・進捗・中断・引継ぎの意味。[UX](../ux/session-coordination.md) |
| コア：作業委任 | agent-delegation | 依頼範囲、担当する実行、親子関係、成果への到達。[UX](../ux/agent-delegation.md) |
| コアを実現する既存の下位責務 | session-lifecycle、autonomous-continuation、session-message-layer、taskflow-instructions、delegation-*、director-*、escalation-mode | session 行の遷移、継続提案、メッセージ投影、依頼の分解・払い出し・起動。上位の UX を参照し、それぞれが所有する状態を他から直接変更させない |
| 支援：成果と外部依頼 | github-issue-workflow、revisor-local-pr、domain-review、delegation-commit | 外部入力の認可、Issue と委託の関係、審査への提出と成果照合。審査の合否は Revisor が所有 |
| 支援：運用・組織 | observability、governance、federation、project-code-registry、testing-traffic、checkout-*、parttimer-review-scheduling | コスト・組織範囲・運用方針・拠点・プロジェクト・作業競合。コアの不変条件を支える |
| 汎用/支援の技術境界 | chat-platforms、http-interface、session-message-webui、runtime-orchestration、persistence、configuration、revisor-credentials、analysis-*、blackbox-decision、tooling、web-test-tooling、transition-guard-example | 配達、API、表示、実行時組立て、保存、秘密、解析、開発支援。技術を交換してもコアの意味を変えない |

この表は戦略上の分類であり、Anatomia の既存ドメインを一括統合・改名する宣言ではない。
コア候補の採否や境界変更は責任者が判断し、理由を記録する。既存の広い pathPattern と個別の
ドメイン宣言が重なる箇所は、今回触るファイルごとに所有する責務を確認してから実装する。
古い生成 taxonomy を手で書き換えたり、全域を新しいフォルダへ移して分類済みとみなしたりしない。

## ユビキタス言語

| 用語 | Cc での意味 | 混同しないもの |
|---|---|---|
| Project binding | 実作業 repo・origin・branch と登録プロジェクトの対応 | プロセスを起動した workspace、表示用のタグ |
| Session | 人間/AI の作業を追跡する主体とその lifecycle | OS の PID 単体、委託 run |
| Delegation run | 一度受け付けた仕事の実行と親子関係 | テンプレ定義、同じ本文を持つ別依頼 |
| Issue run | 一つの外部 Issue 受付から成果公開までの追跡 | GitHub delivery ID、delegation run ID |
| Claim / lease | 作業範囲の申告 / 期限付き実行所有権 | 人間の承認、恒久的な所有権 |
| 起動確認 | 起動の結果が確定して台帳と結び付いた状態 | 起動を要求した事実、応答が無かった状態 |
| 審査通過 | 対象成果に対して Revisor が返した判定 | セッション終了、PR 作成、公開、マージ |
| 配達済み | 送信先が受理したことを確認できた通知 | 文面作成済み、送信試行済み、既読 |
| 完了範囲 | 依頼時に許可された到達点 | 一律のマージ、自動的なサービス再起動 |

同じ単語の意味を HTTP DTO、DB 列、チャット文面で変えない。外部サービスの語彙は adapter で
変換し、外部の状態 enum をそのまま Cc の業務状態の意味として使い回さない。

## 業務不変条件

以下は設計を追跡する安定 ID。すべてが現時点で機械的に強制済みであるという宣言ではない。

| ID | 条件 | 主な所有者と検証対象 |
|---|---|---|
| CC-INV-01 | 作業対象は実 repo・branch と一致し、古い workspace 報告で明示 binding を失わない | session-lifecycle / project binding、入力順序違い |
| CC-INV-02 | 依頼者・組織・対象に対する権限を操作時に確認する | 各 use case の入口、子会社 scope / live staff roster |
| CC-INV-03 | 同一依頼の再送・再起動で確定済み実行を増やさず、結果不明は照合または確認待ちにする | agent-delegation / github-issue-workflow、受付と起動の中断境界 |
| CC-INV-04 | 状態遷移には証拠があり、未確認を成功・完了へ変換しない | session / delegation / Issue run の各状態所有者 |
| CC-INV-05 | 成果と審査の対象を照合し、未審査成果を公開せず、依頼の完了範囲を越える操作をしない | revisor-local-pr / github-issue-workflow |
| CC-INV-06 | 送信試行と配達を分け、警告の失敗で独立した状態表示を複製しない | 通知 application service と transport adapter |
| CC-INV-07 | 所有者の喪失後は新しい仕事を払い出さず、実行中の結果処理を終えてから保存先と資源を解放する | queue / runtime-orchestration / lease |
| CC-INV-08 | 回答待ち・待機指示を自動巡回や無応答で解除しない | autonomous-continuation / 質問の lifecycle |

## 実装の依存方向

```text
HTTP / Discord / Slack / Web / MCP (入力検証・表示・配達)
                  ↓
Application use case (認可・読取・業務判断の呼出し・永続化・副作用の順序)
                  ↓
Domain policy / state transition (業務用語・不変条件・判断)

SQLite / Revisor / Lictor / Excubitor / provider adapter
                  → use case が要求する小さな port を実装
bootstrap / worker entrypoint → port と実装を組み立て、寿命を所有
```

- Domain の判断は明示した入力と結果で表す。Discord SDK、Hono、DB 接続、fetch、process.env を判断関数へ持ち込まない。
- Application は「受け付ける」「起動結果を照合する」「成果を提出する」等、一つの use case を持つ。認可と副作用の順序をここで明示する。
- Repository は状態所有者が要求する保存・CAS・照合の操作を公開する。別ドメインから DB 行を直接更新して状態機械を迂回しない。
- Adapter は外部スキーマの検証と変換を行う。外部 API の結果不明を空の成功へ変換しない。
- 依存の組立てと timer/socket/child/DB の寿命は composition root が所有する。生成側が全終了経路を持ち、停止は重ねて呼んでも安全にする。
- 型と純関数で足りる変更に、空の Entity/Service/Factory クラス群を追加しない。汎用 `shared` に特定業務の分岐を逃がさない。

新規の独立した境界は、必要に応じて既存 feature 配下の `domain` / `application` / `adapters` に分ける。
既存の `src/pr/local-pr-submission.ts` の純粋な計画関数や `src/github/tracker.ts` の遷移判断のように、
責務を説明できる小さな関数も利用する。旧コードを一括移動せず、変更理由の異なる I/O と業務判断から分離する。

## 非同期・再試行・停止の設計

1. 外部副作用より前に依頼と相関 ID を永続化する。外部 I/O を DB transaction の中に持ち込まない。
2. 受理、実行開始、応答確認、保存、通知を別の事実として設計する。DB の CAS と実行相関を組み合わせる。
3. 「失敗が確定した」「成功が確定した」「結果不明」を区別する。結果不明は既存の外部実行を照合し、照合できない場合の運用経路を持つ。
4. exactly-once を根拠なく約束しない。どの境界で重複を抑制し、どこで確認が必要かを仕様へ書く。
5. 停止は新規取得停止 → 実行中の結果処理 → 外部資源・lease・DB の解放を基本とする。待機上限がある場合は超過時の結果保全を定義する。
6. 通知失敗は業務結果を取り消さない。配達状態・再送条件を別に管理し、既読と配達を混同しない。

## 今後の変更手順

1. 対象 repo と実 branch を確認して Cc に登録する。作業は task worktree で行う。
2. UX の価値 ID とシナリオを選ぶ。技術的な修正も、失うと困る利用者の状態を説明する。
3. `spec/domains/` と利用可能な Anatomia の `where` で既存所属・再利用候補を確認する。新しい所属が必要なら先に宣言する。
4. 用語・状態所有者・不変条件・失敗/中断時の回復方法を機能仕様へ書く。既存規則で判断できる局所的な修正は進める。
5. 判断を純関数/小さな domain policy、外部 I/O を adapter、手順を use case として実装する。src と test の所属を同じ変更で維持する。
6. 変更した契約に必要な検証を計画する。実行はユーザーの許可範囲に従う。本セッションはテスト禁止のためテスト結果を作らない。
7. PR には価値 ID、不変条件、変更した境界、移行/復旧方法、実施した検証と未実施項目を記載する。

既存の Anatomia / dependency-cruiser / Revisor の制約を維持する。この文書や AGENTS.md の追加だけで
DDD 全体の自動強制が実装されたとは扱わない。解析不能・未実施はそのまま記録し、検証成功と報告しない。

## 今回の適用と段階移行

| 修正対象 | 価値と不変条件 | 分離する責務 |
|---|---|---|
| Issue の queued 復旧 | UX-CC-W2/W5、CC-INV-03/04 | 復旧可能性の判断、起動の照合、run の保存 |
| queue 停止と lease 喪失 | UX-CC-W5、CC-INV-07 | 所有権判断、新規取得、進行中処理の終了、資源解放 |
| 上限警告の配達順序 | UX-CC-W4、CC-INV-06 | 警告の要否、配達、通知済みの保存 |
| cost 投稿と activity の失敗 | UX-CC-W4、CC-INV-06 | 状態投稿の更新、警告通知、それぞれの失敗処理 |

既存の大きな bootstrap/API/DB facade の全置換は今回の範囲ではない。次にその業務へ変更を入れる際、
呼び出し側を保ちながら対象 use case の境界から順に分離し、無関係な機能の移動を同時に行わない。
新しい戦略的境界の採否はプロダクト責任者、技術的な移行順と契約は開発責任者がレビューする。
