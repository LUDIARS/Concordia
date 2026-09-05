# local PR マージの認可

`POST /v1/prs/local/:id/merge` が誰のどの操作を通すか。

## 1. 置き換えの経緯 (2026-09-05)

旧実装は 2 つを要求していた。

1. 直近の人間指示者が解決でき、その人が社員名簿の `merge_pr` を持つこと
2. セッションスコープ判定 — **セッションの `repo_origin` が PR の `repository` と一致**すること

2 の狙いは「権限を持つ指示者でも、他プロジェクトの PR を横から落とせないようにする」
ことだったが、認可として働いていなかった (neco 指示)。

- **横断作業を塞いでいた。** 複数リポにまたがる作業は Castra (workspace root) を cwd に
  するため `repo_origin` が `LUDIARS/Castra` に固定され、どのプロジェクトの PR も
  マージできない。実際に Ludellus / Ludellus-Server の PR が
  `merge_project_scope_denied` で停止した。
- **回避が自明だった。** `PATCH /v1/sessions/:id` で `repo_path` / `repo_origin` を
  書き換えればそのまま通る。2026-09-05 にこの手順で #1389 / #1390 が実際にマージされた。
  セッションの自己申告を書き換えるだけで満たせる条件は、認可の境界にならない。

## 2. 現在の規則

マージが通るのは、次の **すべて** を満たすときだけ。

| # | 条件 | 判定元 |
|---|---|---|
| 1 | session 行が実在し、直近の人間指示者を解決できる | `sessions` と `session_events` の `inject` (全期間) |
| 2 | その人が `merge_pr` を持つ | `staff_members.role` (管理職以上) |
| 3 | 対象 PR の repository が Concordia の管理下にある | `project_codes.repo_origin` または `team_repos.repo_origin` |

**セッションの cwd / `repo_origin` は一切見ない。**

条件 3 の管理集合は、セッション行の自己申告とは別に管理 API / WebUI から登録する運用データ
(`project_codes` は WebUI `/projects`、`team_repos` は team の repo 割当)。
これにより:

- Castra を cwd にした横断セッションから、登録を書き換えずに他プロジェクトの PR を
  マージできる
- Concordia の管理外リポジトリの PR は、指示者が `merge_pr` を持っていても通らない
- `PATCH /v1/sessions/:id` での自己申告の書き換えは結果に影響しない

条件 1・2 は緩めていない。マージは人間の判断が要る実行点であり、この変更はその
性質を変えるものではない。

## 3. 拒否理由

`merge_project_scope_denied` (403) の `reason`:

| reason | 意味 |
|---|---|
| `local_pr_repo_unknown` | Revisor から対象 local PR の repository を解決できない。所属を確認できないままマージは通さない |
| `project_not_registered` | repository が `project_codes` にも `team_repos` にも無い。`/projects` で repo_origin を登録するか team に repo を割り当てる |

指示者側の拒否は従来どおり `merge_authorizer_unknown` (指示者を解決できない) と
`merge_not_authorized` (`merge_pr` 不足)。

`session_events` は `sessions` への外部キーを持たないため、イベントを読む前に session 行の
実在も確認する。孤立した `inject` イベントだけを認可コンテキストとして扱わない。

読み取り口 (`sessions` / `staff` / `revisor` / `revisorMerger` / `managedProjects`) の
いずれかが未注入なら `local_pr_merge_unavailable` (503)。管理集合を確認できないまま
マージを通さない fail-closed。

## 4. 表記の揺れ

repository の突き合わせは `normalizeRepoOrigin` で `owner/repo` に正規化し、大小文字を
畳んでから行う。同じリポジトリが `https://github.com/LUDIARS/Concordia.git` と
`LUDIARS/Concordia` の両表記で流れてくるうえ、Windows 側の記録は大小文字が揺れる。
表記差を「別プロジェクト」と誤判定すると、直したいときに限ってマージできないという
置き換え前と同じ不安定さに戻る。

認可入力として受け入れる表記は GitHub の `owner/repo`、HTTPS URL、SSH URL に限る。
汎用正規化が解釈できないローカルパスや GitHub 以外の host は
`local_pr_repo_unknown` として拒否し、拒否応答へ原文を含めない。これにより host 間の
`owner/repo` 衝突と、Revisor 由来のローカルパスの反射漏洩を防ぐ。

## 5. 監査

マージ成功時に `session_events` へ `pr-merged` を残す。

```json
{
  "local_pr_id": "…",
  "session_id": "…",
  "outcome": "merged",
  "project": "LUDIARS/Concordia",
  "project_registered_via": "project_codes",
  "authorizer": { "platform": "discord", "user_id": "…", "role": "manager" }
}
```

`project_registered_via` はどの登録で管理下と判定したか (`project_codes` / `team_repos`)。

## 6. 現時点の限界

`merge_pr` は社員名簿の役職 (staff / manager / executive) で決まる **全社共通** の権限で、
Concordia は「この人はこのプロジェクトだけ」という人×プロジェクトの対応表を持っていない。
`staff_members` に team / subsidiary 列は無く、`team_repos` にも人の所属は無い。

したがってここでいう「プロジェクトに対する権限」は
**「`merge_pr` を持つ人 × Concordia の管理下にあるプロジェクト」** までであって、
人ごとのプロジェクト絞り込みではない。それを入れるには新しい設定面
(社員 → team / project の所属) が要る。

また API 全体は loopback 信頼境界で認証を持たないため、条件 3 は loopback へ到達できる
悪意あるローカルプロセスに対する防御ではない。管理 API 自体を保護する必要がある場合は、
Concordia 全体の認証モデルとして別途導入する。
