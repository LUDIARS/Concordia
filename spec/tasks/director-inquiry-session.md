---
task: director-inquiry-session
project: Concordia
kind: 実装
status: todo
created: 2026-08-20T00:00:00.000Z
source_session: lictor-14618068-9b0b-4762-88da-1084e623df0d
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# Director 問診セッション — 人間への問いかけを spawn したセッションに作らせる

設計正本: `spec/feature/director-inquiry-session.md`。
前提: `spec/feature/director-patrol.md` (local PR #743) がマージ済みであること。
未マージのうちは本タスクに着手しない (patrol の tick に相乗りする実装のため)。

## 目的

Director が人間の判断を要する状態を検出したとき、機械文の通知カードで終わらせず、
読み取り専用の問診セッションを spawn して、そのセッションに Decision Request を
組み立てさせる。問いの生成は LLM 側、Director は起動と取り次ぎだけ。

## 完了条件

- [ ] `src/director/inquiry-patrol.ts` (純関数の計画) — 起動候補の決定。
      事由は run 失敗 / spawn 失敗 / 予算超過 / target_repo 未解決 / 参照破損 /
      停滞 (実行可能 step 無しが N tick 継続、既定 N=4)。
- [ ] patrol の tick から呼び出す。workflow binding key は `director` を共用
      (単独 toggle を増やさない)。
- [ ] 起動は delegation `claude-sonnet-5-ask`
      (env `CONCORDIA_DIRECTOR_ASK_CALL_NAME`)、options `{ team, goal_and_go: false }`。
- [ ] 冪等キー `triggered_by = "director-inquiry:<step_id-or-case_id>:<reason>:<UTC YYYY-MM-DD>"`
      を `findRunByTriggeredBy` で確認してから invoke する。停滞で対象 step が無い場合は
      `case_id` を使う。
- [ ] 問診指示テンプレート (`src/director/inquiry-instruction.ts`) — case / step /
      handoff_note / task md path / 直近 run の失敗理由 / 事由 と、spec §3 の
      「1〜3 件に絞る」「options は 2 件以上・推奨を先頭」「回答を待たず session-end」
      「不要なら handoff_note を書いて終わる」を含める。
- [ ] 問診セッションの契約: リポジトリのファイル編集 / commit / push / PR / テスト /
      サービス制御 / 追加 delegation を拒否する (既存 session-contract + deny 述語に載せる)。
      `POST decisions` と自 case の `handoff_note` に限る `PATCH steps` は許可する。
- [ ] ガード: 未回答の問診 decision がある case は起動しない / 1 tick 1 件 /
      UTC 日付で 1 case 3 件 (永続化された問診 run を数える) / 同一 case × 同一事由は
      日付を含む冪等キーで重複抑止。
- [ ] 起動失敗時は従来の機械文 question カード (patrol §1.4) へフォールバックする。
- [ ] 停滞カウンタの持ち方を決めて実装する (in-memory では再起動で消えるので
      director_steps または director_cases 側に最終前進時刻を持たせる)。
- [ ] 単体テスト: 冪等・各ガード・フォールバック・停滞判定・指示文の必須項目。
      巡回エンジンが LLM を呼ばないことを回帰で固定する。

## スコープ (編集可ディレクトリ)

- `src/director/` (inquiry-patrol / inquiry-instruction / patrol からの呼び出し / repo)
- `src/db/` (停滞判定用カラムの migration が要る場合のみ)
- `spec/feature/director-inquiry-session.md` (status を implemented へ更新)

## 非対象

- Cc 側での問い文の生成 (原則どおり行わない)。
- 質問カード UI の変更 (既存 `discord_pending_questions` と ask-bridge をそのまま使う)。
- merge / テスト / サービス制御の自動化。
