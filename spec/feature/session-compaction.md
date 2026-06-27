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

`buildHandoffPrompt()` が直近 transcript + current_task からタスク引き継ぎ用の要約を
claude (既定 sonnet) に作らせる。 構成 (Markdown):

- **現在のタスク / ゴール**
- **これまでに完了したこと** (要点)
- **次の一手** (最優先の続行アクション)
- **未解決の論点 / 判断待ち**
- **重要なファイル・コマンド・PR**
- **参照**: 「細部はこの Discord チャンネル / Slack スレッドの履歴を遡れ」

LLM 失敗時は current_task + 直近イベントから決定論フォールバック資料を作る
(無言で空にしない)。

## 3. コンパクションの流れ (`runCompaction`)

1. handoff を生成。
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
- runCompaction: inject (mock) が `/clear`→Enter→handoff の順で呼ばれること、 投稿が呼ばれること。
- shouldAutoCompact: 閾値 / 区切り / クールダウン / 作業中ガードの各分岐。

## 8. 設計判断

- clear は専用 API ではなく `inject "/clear" + Enter` を使う (Lictor の既存経路。 provider 非依存)。
- 「圧縮されない完全ログ」 = Discord チャンネルそのもの。 handoff はそこへの索引であり、
  細部は遡れる前提なので handoff は短くてよい (再投入コストを抑える)。
- 自動コンパクションは既定 OFF (安全弁)。 まず手動 + 可視化で運用し、 閾値を詰めてから ON。
</content>
