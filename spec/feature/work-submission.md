# 作業成果の提出 (commit / submit の共通入口)

価値: UX-CC-W3 (終了・審査通過・公開・マージを区別して成果を受け取れる)、UX-CC-W1 (対象と権限を取り違えない)。
不変条件: CC-INV-02 (権限)、CC-INV-05 (成果引渡し)。

## 1. なぜ要るか

同じ判断が 4 箇所に分かれていた。

- セッションは手で `git add` / `git commit` する。範囲の絞り方と署名は文章のルールだけで、実体が無い。
- 委託 run だけは `commit-request` → `commit-guard` → `commit-broker` で構造化されている。
- 提出は workflow ごとに違う (Revisor local PR / GitHub PR / main へ直接)。
- その workflow 分岐が Castra のフック (`github-pr-guard.mjs`)、Cc の API、スキル文書に別々に書かれている。

分岐の写しが増えるほど、どれかが古くなる。フックがコマンド文字列を正規表現で拾っているのも、
判断を聞ける入口が無いからである。

## 2. 用語

- **経路 (route)**: 作業成果を main へ渡す手段。`revisor-local-pr` / `github-pr` / `direct-main` / `unregistered` の 4 つ。
- **提出 (submit)**: 経路に沿って成果を出すこと。Revisor への local PR 提出、GitHub PR の作成、main への直接コミットのいずれか。

## 3. 判定 — `resolveSubmissionRoute` (純関数)

入力は「リポジトリの素性」だけで、I/O を持たない。

| 入力 | 由来 |
| --- | --- |
| `repoPath` | `git rev-parse --show-toplevel` |
| `workflow` | プロジェクト登録 (`project_codes.revisor_workflow`)。`revisor` / `github` / `null` |
| `registered` | Revisor にリポジトリ登録があるか |
| `workspaceRoots` | Cc の設定 (Castra のパス) |
| `directMainRepos` | main へ直接コミットする例外 (Villa 等)。設定で与える |

判定は次の順で、先に当たったものを返す。

1. `repoPath` が workspace root と一致 → `direct-main` (Castra 自体。feature branch も PR も作らない)
2. `repoPath` が `directMainRepos` に含まれる → `direct-main`
3. `workflow === "revisor"` → `revisor-local-pr` (GitHub PR は禁止。push は Revisor が行う)
4. `workflow === "github"` → `github-pr` (ブランチ push と GitHub PR が正規手段)
5. それ以外 (未登録) → `unregistered` (どちらとも決められない。人間に確認する)

各経路は「その経路で許される操作」を併せて返す。`allowsGithubPr` / `allowsBranchPush` / `submitEndpoint` の 3 つで、
フックもセッションも同じ値を読む。**この関数が workflow 分岐の唯一の正本**であり、フックは規則を複製しない。

## 4. コミット — `POST /v1/implementation-tools/commit`

セッションが自分の作業範囲をコミットする入口。判定は委託 run と同じ `checkCommitAllowed` を使う
(保護ブランチ、リポジトリ外、ワークスペースルート、宣言ブランチとの不一致、変更過多)。

- 対象は session binding の repo / branch。呼び出し側がパスを偽れない。
- `paths` を省略すると変更全部、与えると そのパスだけを stage する。
- メッセージは呼び出し側が渡す。署名行 (Co-Authored-By / Claude-Session) は入口が付ける。
- 拒否は `commit-guard` の拒否コードをそのまま返す。入口は判断を足さない。

## 5. 提出 — `POST /v1/implementation-tools/submit`

経路を解決し、その経路の提出だけを行う。

| 経路 | 提出 | 既存の実装 |
| --- | --- | --- |
| `revisor-local-pr` | Revisor へ local PR を提出 | `submitReview` (既存の `/review`) |
| `github-pr` | 未実装。`revisor push` と `gh pr create` の手順を返す | — |
| `direct-main` | 何もしない。コミット済みであることを返す | — |
| `unregistered` | 拒否。プロジェクト登録を促す | — |

`github-pr` の自動化は次段。まず**経路の判定と案内を 1 箇所へ集める**ところまでを対象とする。

## 6. 経路の照会 — `GET /v1/implementation-tools/submission-route?repo=<path>`

フックと外部ツール向け。セッション id を必要としない読み取り専用。
Castra の `github-pr-guard.mjs` はこの応答の `allowsGithubPr` だけを見て判断し、自前の workflow 規則を持たない。
