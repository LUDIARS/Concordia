# セッション・コンパクション (引き継ぎ型) — 設計

> 長くなったセッションを「一般的な要約 compact」ではなく **タスク引き継ぎ** で圧縮する。
> 引き継ぎ資料を生成 → Discord/Slack チャンネルへ投稿 → `/clear` → 引き継ぎを読み直して続行。
> 不明点はチャンネル/スレッドのログを遡る。 **Discord チャンネルを durable な記憶として活かす**。
>
> 正本。 中核は `src/control/compaction.ts` / `src/cost/context-estimate.ts` /
> `src/control/auto-compaction.ts`。

## 1. 動機

Claude Code / Codex のコンテキストは有限。 長いセッションは精度劣化・コスト増を招く。
一般的な compact (会話要約で詰める) は「何を要約に残すか」が曖昧で、 タスクの続行に
必要な情報 (現在地・次の一手・未解決点・重要ファイル) が落ちやすい。

そこで **タスク引き継ぎ資料** を作って `/clear` し、 資料を読んで続行する。 資料に
書ききれない細部は **Discord チャンネル (= 会話ログ)** を遡れば復元できる。 チャンネルが
そのまま「圧縮しない完全ログ」の役割を担う。

## 2. 引き継ぎ資料 (handoff)

handoff は **実作業を行った当のセッション自身に書かせる** (session-end 相当)。 切り離した
Sonnet に transcript 抜粋を要約させると「計画段階の発言」しか材料が無く、 並行セッションが
完了させた成果やリポ実状を知らないため「計画では PR-A だが実際は A〜D 完了済み」のような
古い引き継ぎを生む。 当のセッションはフルコンテキストを持つのでこれを自分で解消できる。

- `buildSessionEndHandoffPrompt(currentTask)` が「`/clear` 直前。 session-end 相当の振り返りを
  行い、 **今の実状** (実際にマージ/完了した PR・現ブランチ/HEAD・残タスク・ブロック) を根拠に
  引き継ぎ資料を Markdown で書け。 計画と実状が食い違えば実状を優先。 書き終えても `/clear` 等の
  操作はするな (Concordia が続けて行う)」 というプロンプトを組む。
- これをセッションへ inject し、 セッションが書いた地の文 (assistant text frame) を
  `elicitHandoffFromSession()` が transcript_logs の since_id テールで捕捉する
  (Lictor の transcript-tail → `POST /v1/sessions/:id/transcript-frame` → transcript_logs)。
  inject 前の `transcriptLogs.maxId()` を watermark にし、 以後の assistant 地の文だけ拾う。
  最初の地の文が出てから quiet (新規が途絶える) まで集約。 env で調整:
  `CONCORDIA_COMPACTION_ELICIT_TIMEOUT_MS` (既定 120000) /
  `…_ELICIT_QUIET_MS` (8000) / `…_ELICIT_POLL_MS` (2000)。

構成 (Markdown):

- **現在のタスク / ゴール**
- **これまでに完了したこと** (要点)
- **次の一手** (最優先の続行アクション)
- **未解決の論点 / 判断待ち**
- **重要なファイル・コマンド・PR**
- **参照**: 「細部はこの Discord チャンネル / Slack スレッドの履歴を遡れ」

捕捉が timeout までに得られない場合は、 従来の切り離し生成 (`buildHandoffPrompt()` +
`generateHandoff()` で claude/既定 sonnet に直近 transcript + current_task を要約させる) へ
**フォールバック**する。 それも失敗すれば current_task + 直近イベントから決定論フォールバック
資料を作る (無言で空にしない)。

## 3. コンパクションの流れ (`runCompaction`)

0. **watermark 記録**: inject 前に `transcriptLogs.maxId(sessionId)` を控える。
1. **handoff をセッション自身に書かせて捕捉**: `buildSessionEndHandoffPrompt` を inject + Enter
   → セッションが書いた地の文を `elicitHandoffFromSession` が watermark 以降の transcript で
   捕捉。 timeout で空なら切り離し生成へフォールバック (§2)。
2. **チャンネルへ投稿**: session の Discord チャンネル (Slack スレッド) に handoff を
   投稿し、 可能なら pin する (`📌 引き継ぎ資料`)。 これが「活かすチャンネル」の本体。
3. **`/clear` を inject**: `POST /v1/sessions/:id/inject` で `"/clear"` → Enter (`\r`)。
   Lictor 経由で TUI に渡り、 セッションのコンテキストがクリアされる。
4. **再投入**: 少し待って、 セッションへ次を inject + Enter:
   「直前にこのチャンネルへ投稿した引き継ぎ資料 (📌) を読んで作業を続行せよ。 不明点は
   このチャンネル / Slack スレッドの履歴を上に遡って確認せよ。」
   - 資料本文も併せて inject する (チャンネルを読めない環境でも続行できるよう冗長化)。
5. `subsidiary` と同様、 全ステップを記録し、 結果を返す。

> clear と再投入の間に固定ディレイ (既定 4s、 env `CONCORDIA_COMPACTION_CLEAR_WAIT_MS`)。
> Codex は inject 後に Enter 追送が要る場合があるため別 inject で `\r` を送る。

## 4. コンテキスト長の類推 + 状態カード表示

`estimateContextTokens(session)` が provider ログ (claude/codex JSONL) の **最後の
assistant メッセージの usage スナップショット** からコンテキスト占有を概算する:

- Claude: 最後の `message.usage` の `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens` (= その turn でモデルに送られたプロンプト総量 ≒ 現在の
  コンテキスト占有)。 累積コスト (readClaudeUsage) とは別物。
- Codex: 最後の `token_count.info.total_token_usage` から推定。
- `pct = tokens / windowTokens` (windowTokens 既定 200000、 env で上書き)。

10 分毎の stat tick で `metadata.context_tokens` / `context_pct` を更新し、
**状態カード (Discord session-status-card / Slack card)** に `🧠 ctx ~62% (124k)` を表示。

## 5. 自動コンパクション (監視判断)

`shouldAutoCompact(input)` が純粋関数で判定する:

- **コンテキスト閾値**: `context_pct >= autoThreshold` (既定 0.75)。
- **区切り (breakpoint)**: 直近に「タスク完了」シグナル (PR merged / session-end 的でない
  task_update 完了 / 明示の節目) があり、 かつ `context_pct >= softThreshold` (既定 0.55)。
  → 区切りの良いところで圧縮する (作業の途中をぶつ切りにしない)。
- **クールダウン**: 直近コンパクションから `cooldownSec` (既定 1800s) 未満は抑止。
- **作業中ガード**: 直近に inject/transcript が活発 (= 人間と対話中) なら見送る。

`startAutoCompaction` スケジューラが active セッションを周期 (既定 5 分) で評価し、
条件成立で `runCompaction` を発火。 安全弁 env `CONCORDIA_AUTO_COMPACTION=1` (既定 OFF)。

## 6. 手動トリガ

- **Discord**: `/co-compaction` (現在の session channel のセッションを圧縮)。
- **HTTP**: `POST /v1/sessions/:id/compact` (loopback, token 不要)。
- 結果はチャンネルへ ephemeral or 通常投稿で可視化。

## 7. テスト

- context-estimate: claude/codex JSONL 固定 fixture で最後 usage を拾う / pct 計算 / ログ無で null。
- handoff: prompt builder が current_task・参照指示を含む純粋テスト。 LLM 失敗時フォールバック。
- buildSessionEndHandoffPrompt: 実状優先・current_task・clear 禁止を含む純粋テスト。
- elicitHandoffFromSession: watermark 以降の assistant 地の文だけ捕捉 / user エコー除外 /
  何も出なければ null (フォールバック誘発)。
- transcriptLogs.maxId: frame 無で 0 / セッション別に最大 id。
- runCompaction: inject (mock) が handoff 依頼→`/clear`→Enter→再投入 の順で呼ばれること、
  捕捉失敗時に切り離し生成へフォールバックすること、 投稿が呼ばれること。
- shouldAutoCompact: 閾値 / 区切り / クールダウン / 作業中ガードの各分岐。

## 8. 設計判断

- clear は専用 API ではなく `inject "/clear" + Enter` を使う (Lictor の既存経路。 provider 非依存)。
- 「圧縮されない完全ログ」 = Discord チャンネルそのもの。 handoff はそこへの索引であり、
  細部は遡れる前提なので handoff は短くてよい (再投入コストを抑える)。
- 自動コンパクションは既定 OFF (安全弁)。 まず手動 + 可視化で運用し、 閾値を詰めてから ON。
</content>
