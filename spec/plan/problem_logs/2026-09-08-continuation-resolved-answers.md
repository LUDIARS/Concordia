# 継続 run が確定済みの判断を再質問する

- Date: 2026-09-08
- Status: fixed in working tree; tests not run
- Area: agent-delegation / Memoria task #2146

## Evidence and cause

Memoria #2146 は質問 3316 / 3317 で同じ Castra 取り込み方法を再確認した事例を記録している。
この事例の実機再現は行っていない。main d524f977 の `requeuePartialRun` を静的に確認すると、
新しい run の `extra_prompt` は前 run ID と remaining のみで、確定回答を取得していない。
質問配達の修正後も委託の継続境界で判断が失われる、既知の再発問題である。

## Fix and ownership

UX-CC-W2/W4、CC-INV-03/04/08。質問状態は既存の pending question repository が所有する。
その read port を delegation API に注入し、partial 系列の子セッションから確定回答を取得して
新 run の初期プロンプトへ渡す。別の親・組織・チーム、未回答、本文不明のローカル解決を混ぜない。
系列欠損・循環・取得失敗時は起案せず既存の partial claim を解放する。
DB migration、質問の自動回答、権限の変更はない。

## Verification expectations

ユーザー指示によりテスト・起動・再起動は未実施。差分と呼出し元を静的に照合した。
今後許可された検証では、次を `continuation-answers` / `delegation-partial` の回帰対象とする。

- 複数世代の partial から自由文・選択・複数選択の確定回答が初期プロンプトへ入る。
- 10件を超えた過去回答も失われず、更新回答の順序が保たれる。
- 未回答、本文不明の local 解決、系列開始前の質問は渡らない。
- 別組織・別親の系列、欠損、循環では子を起案せず claim を解放する。
- 取得失敗後の再試行、回答ゼロ、既存 worktree/model/branch 引継ぎを壊さない。

## Limits

意味的に同じ質問かどうかは LLM が回答履歴を参照して判断する。
この修正は未回答質問 API の機械的な重複抑止や、回答者識別（別タスク #2147）を実装しない。
反映には通常の Concordia リリース手順が必要。本セッションでは PR 提出で停止する。
