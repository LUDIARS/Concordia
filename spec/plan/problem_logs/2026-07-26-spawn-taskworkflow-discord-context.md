# Spawn / TaskWorkflow の Discord 文脈と Cc 判定が欠落する

- 日付: 2026-07-26
- 状態: 修正済み
- 対象: Discord Forum spawn、TaskWorkflow、session work claim

## 症状

- Session Forum の投稿に `Cc` と書いても Concordia プロジェクトとして認識されず、session が起動しない。
- ルート起動セッションが `.wt-Concordia-*` で作業を始めても、Discord thread title と `target_project` に `Cc` / Concordia が反映されない。
- Forum の `ThreadCreate` と starter message 作成が競合すると、starter を一度取得できなかっただけで起動が恒久的に失敗する。
- `/spawn` と Forum spawn の依頼者 ID が新規 session へ渡らず、起動した人への mention と follow 案内を出せない。
- spawn / TaskWorkflow の初回 Inject と、起動 session / 委託元 Forum 投稿の相互リンクが session 冒頭に残らない。
- 稼働ルールを表す Forum tag がなく、投稿から選んだルールを起動時 Inject に反映できない。

## 原因

1. project code の解決が `[Cc]` のような角括弧付き表記だけを対象にしており、裸の `Cc` を見ていなかった。
2. worktree 判定が `Concordia-*` のみで、共通運用の `.wt-Concordia-*` prefix を正規化していなかった。
3. session 登録時に pending spawn の `project` を metadata にだけ保存し、衝突監視と表示の正本である `target_project` へ引き継いでいなかった。
4. Lictor の task claim が `branch` / `current_task` のみを送る場合、Cc は `current_task` から対象 project を補完していなかった。
5. Forum starter は `ThreadCreate` 直後に一度だけ取得していた。
6. spawn API、pending spawn、session metadata の経路に Discord requester と startup Inject の項目がなかった。
7. Discord bot は `session.inject` のうち Slack 由来だけを転記し、session start 用の文脈を明示的に投稿する処理がなかった。

## 修正方針

- canonical `PROJECT-CODES.md` を使い、大小文字を保持した裸の project code と repository 名を境界付きで判定する。
- `.wt-` を含む worktree prefix を除いて canonical project code を解決する。
- pending spawn の project を `target_project` と metadata の両方へ保存する。
- `current_task` 更新時、明示 `target_project` がなければ project code / repository 名から対象 project path を補完する。
- Forum starter 取得を短い bounded retry にする。
- requester ID と startup Inject を spawn → pending → session metadata へ運び、session surface 作成直後に一度だけ投稿する。
- startup 投稿には requester mention、起動 session link、Forum 委託元 link を含める。
- `Unity`、`Webサービス`、`アプリ` を runtime rule tag として Session / TaskWorkflow Forum に用意し、選択済み tag を起動時 Inject に含める。

## 回帰テスト

- 裸の `Cc`、`[Cc]`、`Concordia`、`.wt-Concordia-*` を解決する。
- starter の初回取得失敗後に再取得して起動する。
- requester / startup Inject / project が pending spawn から session 登録へ引き継がれる。
- startup context が mention と双方の link を安全な allowed mentions 付きで構築される。
- runtime rule tag を予約語・Forum tag 同期・Forum spawn prompt に反映する。

## 検証結果

- `npm run lint`（本体/test TypeScript + dependency-cruiser）: 成功
- 関連 9 test files / 50 tests: 成功
- delegation service を含む拡張確認 9 test files / 88 tests: 成功
- 実サービスの再起動・起動テストは未実施
