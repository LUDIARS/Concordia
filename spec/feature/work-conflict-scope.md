# Work 衝突監視スコープ (target_project 宣言 + ルート除外)

## 目的

複数セッションが「同じ個別プロジェクトを同時に触っている」作業衝突を検知し、
`branch_conflict` / collaboration-context / worktree 推奨として当事者に伝える。

従来は衝突キーを `session.repo_path` (wrapped agent の cwd の git repo) にしていた。
だが LUDIARS ワークスペースは直下 (`E:/Document/Ars`) 自体が git repo であり、
多くのセッションが cwd=ルートで起動する。これらを `repo_path` で束ねると全員が相互に
「同 repo/branch」衝突扱いになり、umbrella (ワークスペース束) を個別プロジェクトと
誤認してノイズを撒く。

## 仕様

セッションの **衝突キー** を次の 3 ルールで決める (`src/control/conflict-scope.ts`
`conflictRepoKey`):

1. `target_project` を宣言していれば、それを正規化した値。
   → cwd がルートでも、宣言した個別プロジェクト単位で衝突判定する。
2. 未宣言で `repo_path` が Cc 設定のワークスペースルート (`workspaceRoots`) と一致する場合は
   **null** (= umbrella。衝突監視の対象にしない)。**【要件1】**
3. それ以外は `repo_path` を正規化した値 (= 子リポを直接 cwd にした通常ケース。従来どおり)。

衝突 peer = 同一の非 null 衝突キーを持つ他 active セッション。`branch_conflict` は
peer のうち同一 branch のものが 1 つ以上ある場合に true (判定は従来どおり)。

正規化はパス表記揺れ (`\`/`/`・末尾スラッシュ・大文字小文字) を吸収する
(`normalizeRepoKey`)。よって `target_project="E:/Document/Ars/Memoria"` の宣言と、
子リポ `E:/Document/Ars/Memoria` を直接 cwd にしたセッションは同一実体として衝突する。

### target_project の宣言 【要件2】

セッションは自分が実際に扱う個別プロジェクトを宣言できる。cwd がルート (umbrella) でも、
宣言により個別プロジェクト単位の衝突監視に載る。

- 登録時: `POST /v1/sessions` の `target_project` (任意)。
- 後から / 変更: `PATCH /v1/sessions/:id` の `target_project` (repo path 推奨、安定識別子でも可)。
  `null` で宣言解除 (ルール 3/2 の `repo_path` 判定に戻す)。

値は DB `sessions.target_project` に保持。未宣言 (null) が既定。

## 適用箇所

- `src/api/sessions/lifecycle.ts` — 登録/heartbeat 応答の `advisory.branch_conflict` /
  `recommend_worktree`。
- `src/control/collaboration-context.ts` — セッション文脈パケットの `peers` / `conflicts` /
  `recommended_worktree`。

どちらも `findConflictPeers(session, activeSessions, workspaceRoots)` を経由する。

## 非対象 (将来)

- Lictor 側で cwd=ルート起動時に自動で `target_project` を宣言する配線 (現状は API 受理まで。
  宣言はリモート / Lictor / 手動 PATCH のいずれかが行う)。
- 監視対象リポの永続レジストリ化 (現状は宣言ベースで十分)。
