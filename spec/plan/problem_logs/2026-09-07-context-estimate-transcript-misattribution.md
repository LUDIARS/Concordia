# コンテキスト占有の推定が別セッションの transcript を読んでいる

- Date: 2026-09-07
- Status: fixed (このログと同じ PR で修正、Lictor 側の対と合わせて)
- Area: Concordia — cost/context 推定 (`src/cost/log-usage.ts`, `src/cost/context-estimate.ts`) × Lictor — transcript-tail
- Severity: 中。コンテキスト警告が「そのセッションの状態」を表さない。横並びで一斉に鳴り、起動直後にも鳴るため、警告として機能していなかった

## Summary

neco の指摘: 「各セッションのコンテキストの計算が多分間違ってる。同時に来る事や初回に来る事があるので。」

`⚠️ コンテキスト使用量が N% を超えました` が **複数セッションに同時に出る / 起動直後に出る**。
原因は閾値ではなく **セッションと transcript の突き合わせ**。Concordia は
`repo_path` から引いたディレクトリ内で「開始時刻がいちばん近い JSONL」を選ぶ独自ロジックを
持っており、排他が無いので **複数セッションが同じファイルを掴む**。

## Evidence

直近 5 日の `claude-code` セッション 148 本について、`findClaudeLog()` の結果を
登録済み `transcript_path` (Lictor が SessionStart hook 経由で報告した権威パス) と
突き合わせた実測:

| 結果 | 件数 |
|---|---|
| 一致 | 115 |
| **誤り (他セッションの transcript を掴む)** | **18 (12%)** |
| 解決不能 (null) | 15 |

衝突が実際に起きている:

- `01:54:58` と `01:54:59` に起動した 2 セッション → どちらも `1fc3467f….jsonl` を選択
- `05:17:53` と `05:17:55` に起動した 2 セッション → どちらも `23e887d4….jsonl` を選択

秒差で起動した組が同一ファイルを見るため、**同じ数値の警告が同時に飛ぶ**。起動直後で
自分の transcript がまだ薄いときに他人の重い transcript を掴めば **初回から 75% 超**になる。

`repo_path` が cwd と異なるセッション (root で起動して target project が subrepo) は
エンコード先ディレクトリごと外れる。観測時点で稼働していた `lictor-e6a28339`
(`repo_path=E:/Document/Ars/Augur`、実 transcript は `E--Document-Ars` 配下) は
解決不能 (null) だった。

## Regression Context

Lictor 側は同じ問題を先に片付けている。`transcript-tail.ts` は
「mtime 推測は crosstalk 源なので一切しない」と明記し、provider ごとの権威
(Claude=SessionStart hook / Codex=App Server thread / ローカル LLM=filename 施錠) だけで
束縛先を決めている。**Concordia だけが旧来の時刻マッチ推測を残していた。**

## Cause

- `src/cost/log-usage.ts` の `findClaudeLog()` / `findCodexLog()` が
  「開始時刻の近さ」でスコアリングして 1 本選ぶ。同じファイルを 2 セッションに
  割り当てないための排他が無い。
- `estimateContextTokens()` は権威 `transcript_path` を優先するものの、
  **解決できなければ推測へフォールバック**していた。フォールバックが誤りの発生源。
- 推測は cost 系 (`session-cost` / `session-usage-cache` / `windowed-usage*` /
  `channel-cost-cache`) にも同じ形で散らばっており、同じ取り違えを起こしていた。

## Fix

neco の指示: 「今の Lictor がセッション特定するロジックと一致させる。別ロジックは
持たない。フォールバックもしない。」

1. **Concordia**: `resolveSessionTranscript(s)` を唯一の解決経路にする。中身は
   `resolveTrustedTranscriptPath(s.transcript_path, <provider 正本ルート>)` だけ。
   解決できなければ `null` (= 推定不能) を返し、他人のログで埋め合わせない。
   `findClaudeLog` / `findCodexLog` と、それ専用の `readCodexHead` / `readFirstTs` /
   `LOG_MATCH_CLOCK_SLACK_SEC` を削除。cost 系 6 ファイルの呼び出しも同じ関数へ寄せた。
2. **Lictor** (対になる変更): tail している JSONL を **全 provider で** 権威パスとして
   Concordia へ報告する (`reportBoundPath`)。これまで報告していたのは Claude の
   SessionStart hook 経由だけで、Codex は何も届いていなかった
   (実測: `codex-cli` セッション 285 本すべて `transcript_path` が null)。

## Verification

- `src/cost/log-usage.test.ts` を書き換え (5 tests pass):
  - 報告された権威 transcript だけを返す
  - **報告が無ければ、同じディレクトリに実ファイルがあっても推測せず null**
  - provider 正本ツリーの外を指す報告は受け付けない
  - JSONL を持たない provider (codex-sdk) は null
- `src/cost/` + `src/api/chat-read-models.test.ts` + `src/discord/`: 802 tests pass。
  typecheck 0 error。
- Lictor 側: `tests/transcript-tail.test.ts` に「codex が束縛した rollout を権威パスとして
  報告する」を追加。full suite 542 pass / 0 fail / 1 skip。

## Follow-up

- **移行期間がある**。Lictor 側の報告は新規セッションからしか効かないため、それまで
  `codex-cli` セッションの context / cost は `null` (推定不能) になる。誤った数字より
  無い数字のほうが良いという判断で、セッションが入れ替われば自然に解消する。
- 警告そのものの設計は別課題として残る。この環境の Claude セッションは
  **最初の assistant ターンで既に 67,476 tokens (200k 窓の 34%)** を占める
  (system prompt + tool schema + MCP + CLAUDE.md + memory index + skill 一覧)。
  全セッションが同じゲタを履いて同じ速度で上がるため、生の占有率では横並びで鳴りやすい。
  「初回ターンをベースラインとして差分で測る」「モデル別のウィンドウ長を使う
  (200k 固定をやめる)」の 2 点は未着手。
