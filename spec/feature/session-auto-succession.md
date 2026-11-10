---
type: feature
title: "コンテキスト量による自動引き継ぎと、リポ担当エージェントへの受け渡し"
description: "Claude セッションのコンテキスト占有が 1M の 70% (700,000 トークン) を超えたら待機時に次セッションへ handover する。別リポの作業がゲートで止まったとき・リポが分岐したときは、そのリポ (checkout) を cwd にした担当エージェントを立てて作業を渡し、リポごとの実装を個別に管理する。"
service: concordia
domain: session-coordination
tags:
  - handover
  - session-lifecycle
  - multi-repo
  - harness
  - state-machine
status: implemented
related:
  - feature/session-compaction.md
  - feature/work-conflict-scope.md
  - feature/context-observation-authority.md
  - feature/task-branch-harness.md
  - tasks/2026-08-14-handover-command.md
updated: 2026-11-10
---

# コンテキスト量による自動引き継ぎと、リポ担当エージェントへの受け渡し

> 2026-11-10 neco 指示 (時系列)
> 1. 「Claude の場合はコンテクスト量が大きくなってきたら自動で次のセッションに transfer するようにしたい」
> 2. 「リポジトリが増えてタスクが分岐してきたら、エージェントを新しく作りタスク分離してそれぞれで実装させる。
>    これはタスクワークフローとは違い、リポジトリそれぞれの実装を個別に管理するのが目的」
> 3. (Castra root 起点のセッションが Concordia worktree の編集をゲートで拒否され、手動で worktree cwd の
>    新セッションへリレーした件を受けて) 「止められるじゃん？ 対象のリポジトリのエージェントを作って渡せばいいってわけ」
>    「そうできる設計書を作って」
> 4. 「この引継ぎは Codex もやるよ」

## 0. 位置づけと用語

- core domain **session-coordination** の「中断・引継ぎ」「担当」の意味を拡張する。
  リポ担当の親子関係は agent-delegation の委託 (delegation run) とは別物で、taskflow の task state も作らない。
- 用語
  - **自動引き継ぎ (auto handover)**: 同じ作業を新しいセッションへ移し、旧セッションを畳む。
  - **リポ担当エージェント (repo agent)**: 親セッションから、特定の checkout (リポ本体または worktree) の
    実装を任された子セッション。**プロセスの cwd がその checkout** であることが本質。
  - **親 (parent)**: リポ担当を立てたセッション。親は畳まない (自分の主リポの作業を続ける)。
  - **起動 cwd (launch cwd)**: セッション登録時の repo_path。プロセスの cwd は後から変えられない。
- 再利用する既存機構: 手動 handover (`POST /v1/sessions/:id/handover`)、pending succession
  (`src/control/pending-relictor.ts` の spawn ID 照合)、自筆 handoff の捕捉 (`elicitHandoffFromSession`)、
  ゲートの監査記録 (`harness_session_audit`)、`active_repos`。**DB テーブル・migration は追加しない**
  (親子の対応は session metadata に持つ)。
- session-compaction.md §5 の「自動 `/clear` 禁止」は維持する。本機能は `/clear` を発火しない。

## 1. 動機 (UX)

| 場面 | 今 | 本機能後 |
|---|---|---|
| 長時間の作業でコンテキストが膨らむ | 人間が `/co-handover` を打つまで精度低下・コスト増のまま続く | 待機時に自動で次セッションへ移る |
| Castra root 起点のセッションが個別リポの worktree を編集する | ゲート (contract-incomplete / task-branch / outside-scope) が繰り返し止め、登録を直しても cwd 由来の判定で戻る。AI が手で spawn・引き継ぎ文を書いた | 止まった時点で Cc がその checkout の担当を立て、親が書いた依頼文を渡す |
| 1 セッションが複数リポを並行して触る | どのリポの実装がどこまで進んだか 1 セッションに混ざる | リポごとに担当がいて、親は担当一覧で個別に追える |

## 2. 自動引き継ぎ {#CC-AUTO-SUCC-01}

### 2.1 判定 (純関数 `decideContextHandover`)

| 条件 | skip 理由 |
|---|---|
| 機能が有効 (`CONCORDIA_AUTO_HANDOVER`、既定 on) | `disabled` |
| session.status = active | `inactive` |
| provider が Claude 系 (`claude-code`) | `provider_not_claude` |
| 委託子・パートタイマーでない (それぞれの run 管理が寿命を持つ) | `managed_elsewhere` |
| コンテキスト占有が観測できる (観測なしは推測しない) | `unknown_usage` |
| 占有トークン ≥ 閾値トークン (既定 **700,000** = 1M × 70%) | `below_threshold` |
| session-end 進行中でない | `session_ending` |
| 人間への未回答質問が無い | `awaiting_human` |
| 待機中 (§4.1) | `busy` |
| このセッションでまだ自動引き継ぎを試みていない | `already_attempted` |

- **Claude 限定** (neco 2026-11-10): Codex は適切なサイズで自前のコンパクションが走るので対象外。
  Claude は 1M コンテキストで自前のコンパクションが走らないため、引き継ぎで区切ることが目的。
- 閾値の計算: `CONCORDIA_AUTO_HANDOVER_WINDOW_TOKENS` (既定 1,000,000) ×
  `CONCORDIA_AUTO_HANDOVER_PCT` (既定 70) / 100 = **700,000 トークン**。Claude のログには窓サイズが
  出ない (context-observation-authority.md) ので、観測の窓ではなくこの設定窓で計算する。観測ログに
  窓が出ている場合 (将来) もこの設定値を優先し、閾値がぶれないようにする。
- 占有は「最後の request の input + cache_read + cache_creation」(既存の observation)。
- 「人間への未回答質問」は stalled-session-nudge と同じ signal の和で判定する (`awaiting-human.ts`):
  Cc の未回答質問カード・human-wait・人間の確認待ち (`human_response_confirmation`)・transcript 末尾の
  ask マーカー。カードを出さない Lictor relay の ask で返事を待つセッションを畳まないため。
  transcript 末尾の読み取りは、他の条件をすべて満たしたセッションだけで行う。
- **1 セッション 1 回**。実行前に `metadata.auto_handover = {attempted_at, measure}` を記録し、
  結果が不明・失敗でも同じセッションでは再送しない。後継は別 ID なので改めて判定対象になる。

### 2.2 実行

- 監視 `AutoSuccessionWatcher` が一定間隔 (既定 120s) で active セッションを走査し、判定 → 実行する。
- 実行はユースケース `SessionSuccessionService.handover(id, trigger)`。既存の route
  (`/:id/handover`, `/:id/relictor`) もこのサービスへ委譲し、spawn → 旧セッション終了 → 保険 kill の
  機構を 1 箇所に保つ (`src/api/sessions/end.ts` から抽出)。
- 後継の provider は旧セッションと同じ。投稿見出しは自動であることを示す
  (`🤝 次セッション引き継ぎ資料 (自動: ctx 82%)`)。

## 3. リポ担当エージェントへの受け渡し {#CC-AUTO-SUCC-02}

### 3.1 契機

**主契機 — ゲートで止まった (CC-AUTO-SUCC-02a)**

ゲート (`POST /v1/harness/gate`) が編集系の操作を **deny** し、かつ次を満たすとき。

1. 操作の対象 checkout (`action.cwd` / `filePath` から解決したリポ root。worktree ならその worktree) が
   Cc 登録プロジェクトに解決できる (`resolveRegisteredRepo`。`<repo>/.wt-*` は `<repo>` に寄せる)。
2. その checkout が、セッションの **起動 cwd の checkout と異なる** (= cwd 由来の判定が今後も一致しない)。
3. deny の rule が「cwd と作業先のずれ」で起きる種類である: `task-branch` / `contract-incomplete` /
   `outside-scope` (warn は契機にしない) / `max-repos`。安全上の deny (秘密・危険コマンド・相談境界・
   main push 等) は契機にしない — 担当に渡しても同じ規則で止まるべきものだから。

対象 rule の集合は純関数 `isRepoMismatchDenial(hit)` が持ち、新しい rule を足すときはここだけ直す。

**副契機 — リポが分岐した (CC-AUTO-SUCC-02b)**

`active_repos` (起動 cwd の主リポを除く) に Cc 登録プロジェクトが 1 件以上あり、主リポを含めて
2 リポ以上を触っているとき。監視 (§2.2 と同じ走査) で判定する。

**手動 — 親が自分で頼む (CC-AUTO-SUCC-02c)**

親の発言に §3.3 の `repo-brief` ブロックがあれば、契機が無くても受け付ける
(`POST /v1/sessions/:id/repo-agents` でも同じ)。

### 3.2 判定 (純関数 `decideRepoAgentHandoff`)

| 条件 | skip 理由 |
|---|---|
| 機能が有効 (`CONCORDIA_REPO_AGENTS`、既定 on) | `disabled` |
| 親が active で、provider が spawn 可能 (Claude / Codex) | `not_spawnable` |
| 親がリポ担当・委託子・パートタイマー自身でない (再帰防止) | `managed_elsewhere` |
| その checkout の担当がまだいない (状態 `requested`〜`active`) | `already_assigned` (→ §3.5 の案内) |
| 親の担当数 < `CONCORDIA_REPO_AGENTS_MAX` (既定 3) | `agent_limit` |
| session-end 進行中でない | `session_ending` |

- 待機条件 (§4.1) は課さない。依頼文は親自身が書くので、作業中でも親の次の発言で受け取れる。
- 全体の同時 spawn は 1 走査・1 分あたり最大 2 (大量同時 spawn で Excubitor が落ちた事故の再発防止)。
  超えた分は `requested` のまま次の機会に回す。

### 3.3 依頼文 (repo-brief)

担当へ渡す依頼文は **親自身に書かせる**。実作業の文脈を持つのは親だけで、切り離した要約では
計画と実状がずれる (session-compaction.md §2 と同じ理由)。

- 主契機では、ゲートの deny 応答 (`suggestion`) に依頼文の書き方を載せる。親のモデルは拒否理由を
  そのまま受け取るので、追加の inject なしに次の発言で書ける:

  ````
  このリポは起動 cwd と違うため、このセッションからは編集できません。Cc がこの checkout
  (E:/Document/Ars/Concordia/.wt-x) の担当エージェントを立てます。次の形式で依頼文を書いてください。
  ```repo-brief
  {"checkout":"E:/Document/Ars/Concordia/.wt-x","brief":"目的・変更内容・受入条件・関連ファイル/PR・許可範囲 (テスト・マージ)"}
  ```
  ````
- 副契機では、監視が待機中 (§4.1) の親へ同じ文面を inject する。
- 捕捉: transcript frame の受け口 (`POST /v1/sessions/:id/transcript-frame`) で、親の assistant 地の文に
  `repo-brief` ブロックがあれば解析する (`parseRepoBriefs`、純関数)。Claude・Codex とも Lictor が
  transcript を送るので provider によらない。
- 検証: JSON 不正・`checkout` が登録プロジェクトに解決できない・`brief` が空 のブロックは捨て、
  親へ理由を返す。`checkout` が `requested` 行と一致しなければ手動 (02c) として扱う。
- `requested` のまま `CONCORDIA_REPO_AGENTS_BRIEF_TIMEOUT_SEC` (既定 600) を過ぎたら `brief_missing` で
  閉じる。親の文脈なしに子を立てない (INV-5)。

### 3.4 担当を立てる (`RepoAgentService`)

状態は親 metadata `repo_agents[]` の 1 行 (checkout 単位) が持つ。

```
requested ──brief 受領──▶ spawning ──子が登録──▶ active ──子が終了──▶ ended
    │                         │
    └─timeout─▶ brief_missing └─spawn 失敗─▶ spawn_failed
```

1. **記録先行**: 契機を受けたら `{checkout, project_code, trigger, rule, status:"requested", at}` を書く。
   以後同じ checkout では契機を重ねない (INV-1)。
2. **brief 受領**: 行を `spawning` にし、spawn ID を払い出す。pending succession に
   `{kind:"repo-agent", cwd: checkout, spawnId, handoff: 子への依頼文, parent, checkout}` を登録し、
   `spawnSession({provider: 親と同じ, cwd: checkout, mode:"tab", title: "[<code>] <brief 1 行目>"})`。
   spawn 失敗は `spawn_failed` にして pending を破棄する。
3. **子の登録** (`POST /v1/sessions`、spawn ID 一致で claim): 子 metadata に
   `repo_agent_of = {parent_session_id, checkout, project_code}` を書き、依頼文を inject する。
   親の行に `child_session_id` を書いて `active` にする。子への依頼文の先頭には
   「親 <id> から <checkout> の実装を任された担当であること、許可範囲は brief の記載に従い、記載が
   無ければ通常の作業規則に従うこと、完了・判断待ちは親へ報告されること」を機械で付ける。
4. **親への通知**: 立てた担当 (session id・checkout・Discord スレッド) と、追加依頼の送り方を inject する。
   以後その checkout の実装は担当へ任せる。
5. **終了**: 子の `session.ended` で親の行を `ended` にし、子の最後の発言の抜粋と PR 番号 (分かれば) を
   親へ inject する。親が畳まれていれば何もしない (結果は子のチャンネルに残る)。

### 3.5 同じ checkout で再び止まったとき

担当がいる (`requested`〜`active`) checkout でゲートが再び deny したら、新しい担当は立てず、
deny 応答の `suggestion` を「担当 <child id> がいます。追加の依頼は repo-brief ブロックか
`POST /v1/sessions/<child>/inject` で渡してください」に変える。担当がいる状態で `repo-brief` が来たら、
spawn せずに子へ inject する (追加依頼)。

### 3.6 管理

- `GET /v1/sessions/:id/repo-agents` — 親の担当一覧 (checkout / project_code / 状態 / 子 session id /
  子の現 status / 契機)。子の行からは `repo_agent_of` で親を引ける。
- Discord: 親スレッドに「担当: [Cc] .wt-x → <子スレッド>」の 1 行を投稿する (担当が立った時・終わった時)。
- 親が担当の checkout を編集するのは止めない (今までどおりゲートの規則に任せる)。分担は通知と一覧で示し、
  強制済みとは扱わない。

## 4. 共通

### 4.1 待機中の判定 (純関数 `isSessionIdle`)

最後の transcript frame が完了境界 (`isTranscriptCompletion`: 最終回答 / summary) で、その後
`CONCORDIA_AUTO_SUCCESSION_QUIET_SEC` (既定 60) 以上新しい frame が無いときだけ待機中とする。
frame が無いセッションは待機中としない。作業中の turn に依頼を割り込ませると、依頼への回答ではなく
作業中の出力を捕捉してしまうため。

### 4.2 設定

すべて env で読み、adapter (`succession-settings.ts`) が純関数へ値として渡す。判定関数は env を読まない。
`config/settings/definitions/session.ts` にも項目を登録し、WebUI の設定一覧に出す。

## 5. 不変条件

- INV-1: 自動引き継ぎは同一セッションにつき 1 回、リポ担当は同一 (親, checkout) につき同時に 1 つ。
  記録を先に書き、結果不明で再送しない。
- INV-2: コンテキスト占有が観測できないときは自動引き継ぎしない。閾値は設定窓 (1M) × 70% で決め、観測から推測しない。
- INV-2b: 自動引き継ぎは Claude だけ。Codex は対象外 (リポ担当 §3 は Claude / Codex 両方)。
- INV-3: 作業中 (§4.1 が偽) のセッションへ自動の依頼 inject を割り込ませない
  (ゲートの deny 応答に依頼文の書き方を載せるのは、親の操作への応答なので割り込みではない)。
- INV-4: 自動経路は `/clear` を発火しない。
- INV-5: リポ担当は、親が書いた repo-brief を受け取った checkout にだけ立てる。
- INV-6: 安全上の deny (秘密・危険コマンド・相談境界・main push 等) を担当への受け渡しで回避しない。
  契機にするのは cwd と作業先のずれによる deny だけ。
- INV-7: リポ担当は親と同じ provider で立てる (Claude 親 → Claude 担当、Codex 親 → Codex 担当)。

## 6. 実装の割り当て

| 層 | ファイル (新規は `src/control/succession/`) | 責務 |
|---|---|---|
| ドメイン (純関数) | `context-handover-policy.ts` | §2.1 |
| ドメイン (純関数) | `session-idle.ts` | §4.1 |
| ドメイン (純関数) | `repo-agent-policy.ts` | `resolveRegisteredRepo` / `isRepoMismatchDenial` / `decideRepoAgentHandoff` / 副契機の分岐判定 |
| ドメイン (純関数) | `repo-brief.ts` | 依頼文の書き方・解析・子への依頼文・親への通知文 |
| ドメイン (純関数) | `repo-agents-state.ts` | metadata `repo_agents[]` の読み書きと状態遷移 (§3.4 の図以外の遷移を拒否) |
| ドメイン (純関数) | `auto-handover-metadata.ts` | metadata `auto_handover` (試行記録) の読み書き (INV-1) |
| ドメイン (純関数) | `managed-session.ts` | 委託子・パートタイマー・リポ担当自身の判定 (managed_elsewhere / 再帰防止) |
| ドメイン | `spawn-budget.ts` | 自動経路の spawn 上限 (直近 60 秒に 2 件、自動引き継ぎとリポ担当で共有) |
| ユースケース | `session-succession-service.ts` | handover / relictor (end.ts から抽出) |
| ユースケース | `session-handoff-author.ts` | 旧セッション自身に handoff を書かせる (捕捉失敗時は切り離し生成) |
| ユースケース | `repo-agent-service.ts` | §3.4・§3.5 |
| ユースケース | `auto-succession-watcher.ts` | 走査と判定の呼び出し、spawn 上限 |
| adapter | `succession-settings.ts` | env → 設定値 |
| adapter | `session-succession-wiring.ts` | SessionSuccessionService の実 I/O 配線 (route の既定配線と runtime で共有) |
| 配線 | `succession-runtime.ts` | サービス・監視・session.ended 購読の組み立て (bootstrap から呼ぶ) |
| 配線 | `src/api/harness-session.ts` | deny 後に `isRepoMismatchDenial` → `RepoAgentService.onGateDenied`、suggestion 差し替え (reason にも併記) |
| 配線 | `src/api/sessions/relay.ts` | transcript frame から repo-brief を `RepoAgentService.onAssistantText` へ |
| 配線 | `src/api/sessions/repo-agents.ts` | `GET` / `POST /v1/sessions/:id/repo-agents` (§3.6, 02c) |
| 配線 | `src/api/sessions/successor-reinject.ts` | 後継 (relictor / handover / repo-agent) への inject 見出しと source の選択 |
| 配線 | `src/control/pending-relictor.ts` | pending kind `repo-agent` と親子の対応 (`repoAgent`) |
| 配線 | `src/config/settings/definitions/session.ts` | §4.2 の env を設定一覧へ登録 |
| 配線 | `src/api/sessions/lifecycle.ts` | pending kind `repo-agent` の claim、子 metadata・親行の更新 |
| 配線 | `src/api/sessions/end.ts` | route を `SessionSuccessionService` へ委譲 |
| 配線 | `src/bootstrap/core.ts` | watcher 起動、session.ended 購読 |

## 7. 受入条件

- [ ] `decideContextHandover`: 表 2.1 の各行の handover / skip。699,999 は skip・700,000 は handover・Codex は常に skip。
- [ ] `isRepoMismatchDenial`: 対象 rule は真、安全上の rule・warn は偽。
- [ ] `decideRepoAgentHandoff`: 起動 cwd と同じ checkout・未登録リポ・worktree 正規化・既存担当・上限・再帰防止。
- [ ] `parseRepoBriefs`: 複数ブロック・不正 JSON・未登録 checkout・空 brief。
- [ ] `repo-agents-state`: 図の遷移だけを許し、同じ checkout の重複行を作らない。
- [ ] ゲート deny → 行 `requested` + suggestion に依頼文の書き方。同じ checkout の 2 回目は §3.5 の案内。
- [ ] repo-brief 受領 → pending 登録 → spawn (provider 親と同じ) → 子登録で依頼文 inject と親子 metadata の結合。
- [ ] spawn 失敗で `spawn_failed`・pending 破棄。brief timeout で `brief_missing`。
- [ ] 子の終了で親へ抜粋が届き、行が `ended`。
- [ ] `/:id/handover` `/:id/relictor` の既存挙動 (409 重複・spawn 失敗時の pending 破棄) が回帰しない。
- [ ] watcher が判定 → 記録 → 実行の順で呼び、1 走査の spawn 上限を守る。

テストはすべて fake port で I/O なしに書く。テストの実行・サービス再起動は人間の許可範囲で行う。

## 8. 復旧

- 無効化: `CONCORDIA_AUTO_HANDOVER=0` / `CONCORDIA_REPO_AGENTS=0` で判定が常に skip になり、
  ゲートの suggestion も従来文言に戻る。
- 誤って立った担当は通常のセッション終了で畳む。親 metadata の行は履歴として残る。
- pending succession はプロセス内メモリ (TTL 5 分) なので、Cc 再起動で `spawning` の行は子が来なくなる。
  起動時に `spawning` で 5 分を超えた行は `spawn_failed` に倒す。

## 9. 未決 (人間判断)

- 担当上限 3 の既定値。(自動引き継ぎの閾値は neco 決定: Claude 1M × 70% = 700,000)
- 担当の子に、親が持っていた Goal & Go・マージ許可を引き継ぐか (案: brief に書かれた許可範囲だけを渡す)。
