---
title: CDGD マネジメント層 (dots サイドカー)
id: CC-MGMT
status: draft
domain: management
---

# CDGD マネジメント層 (dots サイドカー)

> 所属ドメイン: [`management`](../domains/management.domain.json)

2026-10-01 neco 指示: 「CDGD のマネジメントレイヤに dots を配置する / Cc サイドカーに置く」の
実装設計 (Codex セッション lictor-76713395、2026-09-30〜10-01) をレビューして実装する。
同日追記: **dots の管理は Cc がやる**。

dots は CDGD 全体を継続して見る横断判断者で、Cc と並ぶ論理的なサイドカーに置く。
dots が持つのは「観測・判断・依頼・成果の追跡」だけで、実装・Pf 更新・Di 議論・返信配送・検証は
Cc と Cc が起動したセッションが行う。dots は各サービスへ直接書き込まない。
**任務 (mission)・資格情報・判断記録・依頼・処理済み位置は Cc が所有する**。dots の記憶は補助で、
再開時は Cc から読み直す。

## 価値・所属

UX-CC-W2/W4/W5、UX-CC-S2/S3/S5/S6。失うと困る状態は任務の範囲と停止、dots の判断理由、
依頼の同一性と起動の結果、成果と受入・効果確認の区別、処理済み位置。
`management` は agent-delegation の下位責務 (依頼範囲・担当する実行・成果への到達) で、
コアそのものではない。HTTP・MCP・spawn・保存は adapter。既存の spawner と部署・inject を使い、
session / delegation run の状態を直接書き換えない。
不変条件: CC-INV-02/03/04/06/07/08 と下記 CC-MGMT-INV-*。

## 元設計へのレビュー所見と反映

| # | 所見 | 反映 |
|---|---|---|
| R1 | 「Cc に登録されたマネジメント主体」の認証が無い。Cc の loopback は全 AI セッションが叩けるため、dots 専用操作を区別できない | 任務ごとに Cc が Bearer トークンを発行 (平文は発行時だけ返し、DB は SHA-256 のみ)。dots 向け API はトークン必須。回転・停止で無効化 |
| R2 | `read_management_changes` の出所が未定義。Cf/Di/Pf の変更を Cc は持っておらず、Cf には一覧読み出し API も無い | Cc に変更の受付口 (`POST /v1/management/events`) を設け、各サービスが push する。Cc 自身の依頼の状態変化も同じ列へ積む。未接続の出所は「変更なし」と返さず、出所ごとの最終受信時刻を返す |
| R3 | 「元イベント・対象・作業種別から重複候補を照合」が曖昧 | Cc は決定的な一致 (同じ project + target_key + kind の未完了依頼) だけを扱う。意味的な重複判断は dots の判断記録に残す |
| R4 | 起動確認の手段が無い (admin spawn は session id を返さない) | 依頼ごとに固定 spawn ID を保存してから起動し、session metadata の `concordia_spawn_id` で照合して起動確認する。例外時は launch_unknown として照合し、期限切れだけを起動失敗にする |
| R5 | 「判断を保存した変更まで処理済み位置を進める」の強制手段が無い | `record_management_decision` を追加。acknowledge は対象範囲の全イベントが判断か依頼の根拠に含まれる場合だけ受理する |
| R6 | AI 返信の再取り込み防止が文面だけ | イベントに origin (human/ai/system) と親依頼 ID を持たせる。AI のみの根拠は任務が明示的に許可した場合に限る |
| R7 | 上限 (同時数・回数・費用) の強制が無い | 任務の同時依頼数・日次依頼数で拒否、Cc のコスト上限中は起動を保留 |
| R8 | 受入・効果確認を誰が付けるかが無い | 成果記録は担当セッション本人だけ。任務が自律評価を許可した範囲で dots が受入・効果確認でき、判断者を記録する |
| R9 | dots からの即時起動 API・イベント push は検証前 | 初期版はポーリングのみ。dots の継続任務から `changes` を読む |

## 契約 CC-MGMT-01 任務 (Cc が管理する)

- 任務は名前・部署 (CDGD)・対象プロジェクト (1 件以上)・目標・許可する依頼種別・人間判断へ戻す依頼種別・
  効果確認の要否・同時依頼数上限 (既定 3)・日次依頼数上限 (既定 10)・確認間隔の目安・状態 (active/stopped) を持つ。
- 作成・更新・停止・再開・トークン回転は人間の管理面 (`/v1/admin/management/*`) から行う。
  管理面は他の `/v1/admin/*` と同じ loopback 信頼境界で、同じ PC の AI セッションも到達できる (既存と同じ制約)。
  トークン平文は作成と回転の応答でだけ返す。
- 停止中の任務は新しい依頼・判断を受け付けない。読取りと実行中依頼の状態は保持する (CC-MGMT-INV-05)。
- `allow_ai_only_evidence` と `autonomous_evaluation` は独立した任務設定で、既存任務・新規任務とも既定は `false`。

## 契約 CC-MGMT-02 変更の受付と配信

- `POST /v1/management/events` (loopback): `{event_key, source, kind, project_code, origin, summary,
  target_key?, parent_request_id?, ref_url?, observed_at?}`。event_key で冪等、同じキーで内容が違えば 409。
- 依頼の状態遷移は Cc が source=`cc`、parent_request_id 付きで同じ列へ積む。自律評価の origin は `ai`、その他は `system`。
- `changes` は任務の対象プロジェクトのイベントを seq 昇順で返す。応答に出所ごとの最終受信時刻を含める。

## 契約 CC-MGMT-03 dots 向け API (Bearer トークン)

| 操作 | HTTP | MCP tool |
|---|---|---|
| 文脈 | `GET /v1/management/context` | `read_management_context` |
| 変更 | `GET /v1/management/changes?after=&limit=` | `read_management_changes` |
| 判断記録 | `POST /v1/management/decisions` | `record_management_decision` |
| 依頼 | `POST /v1/management/requests` | `submit_management_request` |
| 依頼照会 | `GET /v1/management/requests/:key` | `get_management_request` |
| 自律評価 | `POST /v1/management/requests/:key/evaluate` | `evaluate_management_request` |
| 処理済み | `POST /v1/management/acknowledge` | `acknowledge_management_changes` |

- 文脈は任務・未完了依頼・直近の判断・処理済み位置・未処理件数・対象プロジェクトの稼働セッション
  (照合用の参考。所有は主張しない)・出所の最終受信を返す。
- 依頼は `{request_key, kind, project_code, target_key, purpose, completion_criteria, evidence_seqs[], rationale}`。
  request_key で冪等。内容が違えば 409。
- 判断は `{decision_key, verdict: wait|skip|investigate|attach, evidence_seqs[], rationale}`。依頼は自動で verdict=request を記録する。
- MCP は stdio サーバ `dist/mcp/management-server.js` (env `CONCORDIA_MANAGEMENT_TOKEN`)。dots の接続済み PC で動かす想定。

## 契約 CC-MGMT-04 依頼の受付と払い出し

受付順序 (すべて 1 トランザクション):
1. 任務が active、種別が許可内、project が任務の対象内、根拠 seq が任務から見えるイベントであること。
2. 根拠が全て origin=ai で任務の `allow_ai_only_evidence` が `false` なら拒否 (`evidence_ai_only`)。
3. 同じ request_key → 既存を返す。
4. 同じ project + target_key + kind の未完了依頼があれば `attached` (親を記録)。親が稼働セッションを持てば
   そのセッションへ追加情報を inject する (送信試行。配達は未確認として扱う)。
5. 同時数・日次上限を超えれば拒否。
6. 種別が人間判断対象なら `waiting_human`、それ以外は `queued`。

払い出し (2 秒ごと、1 件ずつ):
- `queued` → spawn ID を保存して `launching` → 部署・プロジェクトを焼いた session を起動。
  起動失敗が確定 → `launch_failed`。例外 (結果不明) → `launch_unknown`。
- `launching`/`launch_unknown` は spawn ID で session を照合して `dispatched`。
  期限 (5 分、spawn 照合の寿命) を過ぎても現れなければ `launch_failed`。同じ依頼を別 ID で再起動しない。
- `dispatched` の session が ended → `execution_finished`。
- コスト上限中は `queued` のまま起動しない。
- 遮断状態が OPEN の間は新規受付と払い出しを止める。受付済みの同一キーによる照会と起動・終了の照合は継続する。

## 契約 CC-MGMT-05 成果・受入・効果確認

| 状態 | 意味 | 遷移させる主体 |
|---|---|---|
| execution_finished | セッションが終わった | Cc (session 観測) |
| outcome_recorded | 成果の要約と参照が保存された (= 受入待ち) | 担当セッション本人 `POST /v1/management/requests/:id/outcome` |
| accepted | 受入済み。効果確認が要る任務では効果確認待ち | 人間 (管理面) または自律評価を許可された dots |
| effect_confirmed / effect_not_met | 狙った改善の確認結果 | 人間 (管理面) または自律評価を許可された dots |
| rejected | 人間判断で却下 (waiting_human から) | 人間 (管理面) |

dots の自律評価は active かつ `autonomous_evaluation` を有効にした任務の依頼に限る。`waiting_human` と
`human_gate_kinds` は人間が評価する。`{action, evidence_seqs?, note?}` の `accept` は `outcome_recorded` からのみ、
`effect_confirmed` / `effect_not_met` は `accepted` かつ `requires_effect_check` が true の場合のみ受け付ける。
効果判定には任務から可視な `evidence_seqs` が必須。自律評価は `[ai:dots]` と根拠を履歴に記録する。

## 契約 CC-MGMT-06 人間の管理面 (Web / Discord)

2026-10-01 neco 指示「上から順に対応」の 2 件目。
- Web `/management`: 任務の一覧・作成・停止・再開・トークン回転 (平文は応答時だけ画面に出し、保存しない)、
  自律受付・評価の設定、依頼の一覧と人間操作 (承認・却下・受入・効果あり・効果なし)。操作者名を入力して記録する。
- Discord 本社 guild の `CDGD管理` チャンネル: 人間が見るべき状態 (waiting_human / launch_failed /
  execution_finished / outcome_recorded / 効果確認待ちの accepted) になった依頼をカードで出す。
  以後の状態変化は同じカードを編集する。ボタンは状態で許される操作だけを有効にし、操作者は
  `discord:<user id>` で記録する。押せるのは社員名簿の `session_control` (管理職以上) を持つ人だけ (雑務と同じ判定)。
- 自律評価対象の依頼に新しいカードを出すのは `waiting_human` と `launch_failed` のみ。既存カードは引き続き更新する。
- 配達は依頼の revision ごとに記録する (`delivered_revision` / `discord_message_id`)。保存してから配達し、
  配達失敗は依頼の状態を変えず次の周期で再送する (CC-INV-06)。
- これらの経路は `/v1/admin/management/*` を使い、dots のトークンでは呼べない (CC-MGMT-INV-01)。

## 契約 CC-MGMT-07 dots 専用の入口 (リモート PC 向け)

2026-10-01 neco 判断「専用入口を作る」。dots の接続先がリモート PC のとき、Cc 本体の
`127.0.0.1:11111` には届かない。トンネルで 11111 を晒すと loopback 信頼の管理 API まで届くので、
dots 用の 7 操作 (CC-MGMT-03) だけを通す別 listener を立てる。

- 既定 OFF。`CONCORDIA_MANAGEMENT_LISTEN=1` で有効、`CONCORDIA_MANAGEMENT_LISTEN_HOST` (既定 127.0.0.1) と
  `CONCORDIA_MANAGEMENT_LISTEN_PORT` (有効時は必須、暗黙の既定ポートを作らない) で待ち受ける。
  ポートの正本は Concordia の Excubitor catalog。変更は再起動で反映する。
- 通すのは `/v1/management/{context,changes,decisions,requests,requests/:key,requests/:key/evaluate,acknowledge}` だけ。
  変更の受付口 (`/events`)・成果記録 (`/requests/:id/outcome`)・`/v1/admin/*` ほか全経路は 404。
- 全操作で Bearer トークン必須 (CC-MGMT-INV-01)。認証失敗は送信元ごとに 1 分 5 回までで、超えたら
  その窓の間は 429 を返す。本文は 64KiB まで。
- TLS は前段 (Tailscale など) に任せる。host に `tailscale` を指定すると、起動時にこの PC の Tailscale アドレス
  (100.64.0.0/10) を探して bind する (マシン固有の IP を catalog に書かない)。見つからなければ起動せず通知する。
- 起動失敗 (ポート使用中など) は Cc 本体を止めず、エラー通知とログに出す。

## 契約 CC-MGMT-08 Cloudflare Access 経由の公開 (dots 専用クラウド向け)

2026-10-02 neco 指示「dots リモートからやる場合、CF Access で専用の認証フローを作る」「1 よい」。
dots の専用クラウドは Tailscale に入れないため、CC-MGMT-07 の入口を Cloudflare Tunnel で公開する。

- `CONCORDIA_MANAGEMENT_PUBLIC_HOST` (例 `cdgd-mgmt.ai-run-do.com`) を設定すると、この Host 宛ての要求は
  Cloudflare Access の application token (`Cf-Access-Jwt-Assertion`) を検証できたものだけ通す (403 `access_required`)。
  検証はチームの JWKS で RS256 署名と iss / aud / exp / nbf を見る。人間 (email) とサービストークン (common_name) の両方を受ける。
- Tailscale から直接来る要求 (Host が IP) には課さない。入口は Tailscale のアドレスに bind したまま、Tunnel の origin もそこへ向ける。
- team / aud は `CONCORDIA_MANAGEMENT_CF_ACCESS_TEAM_DOMAIN` / `_AUD` を優先し、無ければ Excubitor runtime-config の
  `cloudflareAccess` (cf:ex-access が書く) を使う。両方未設定の間は公開 Host 宛てを全部 403 にし (検証なしで開けない)、
  Tailscale 側は動かしてエラー通知に出す。片方だけ・形式不正は設定ミスとして入口を起動しない。
- 任務トークン (Bearer) は従来どおり必須。Access は「入口に届いてよい相手」、トークンは「どの任務か」を決める。
- dots 側の MCP クライアントは `CONCORDIA_MANAGEMENT_CF_CLIENT_ID` / `_SECRET` があればサービストークンのヘッダを付ける。
- Access アプリ・サービストークン・許可ポリシー・Tunnel route・DNS は Cloudflare 側の設定 (人間が作る、または cf:* を人間が実行)。

## 契約 CC-MGMT-09 自走ループのサーキットブレーカー

Actio `6206f9a5-6842-41df-ad2c-7f6ecbbb7504`、`3ec254ec-f6f9-45fb-b83d-34d4f60897fe`。
Cc が共有の遮断状態・設定・開始と結果の履歴を SQLite に保存する。管理依頼は払い出し時に確認し、外部ループは
開始前に loopback の `POST /v1/autonomous-loop/circuit-breaker/check` を呼び、`run_id`、`project_code`、
`target_key`、任意の `session_id` を渡す。受付された実行は同じ `run_id` を `/failure` または `/success` に報告する。
同時数は、管理依頼の起動・照合中/実行中と、開始確認済みで結果未報告の外部実行を合算する。

- 自動遮断はコスト上限、連続失敗 3 回、同一 project と target の 30 分内の 3 回目の開始試行、
  同時 5 件を超える開始試行、5 分内の 10 回目の開始試行。`launch_failed` と `effect_not_met` を失敗、
  効果確認が不要な `accepted` と `effect_confirmed` を成功として扱う。
- `GET /circuit-breaker` で状態を参照できる。`/trip` は手動遮断、`/reset` は明示解除、`PATCH /config` は
  `consecutive_failures`、`target_oscillation`、`concurrency_limit`、`trigger_rate_limit`、`cooldown_ms` の変更に使う。
  OPEN 時の check は 409 `circuit_breaker_open`。完了済みの実行結果は保持し、同じ `run_id` の再送で集計し直さない。
- 既定の `cooldown_ms=null` は明示解除まで停止。クールダウンは次の状態確認時に適用する。解除で連続失敗・短期の
  開始集計をリセットし、実行中の枠や未配達の遮断通知は保持する。コスト上限や同時数は次の開始判定でも確認する。
- CLOSED から OPEN への遷移を管制チャンネルに通知する。理由・既知の対象・セッション直リンクをメンションなしで送り、
  配達できなければ記録を残して次の周期で再試行する。

## 不変条件

- CC-MGMT-INV-01: dots のトークンで呼べるのは CC-MGMT-03 だけ。人間の管理面と遮断操作は別の信頼境界にある。
- CC-MGMT-INV-02: 同じ request_key / event_key / decision_key は 1 件。再送は同じ結果を返す。
- CC-MGMT-INV-03: 起動は依頼 1 件につき spawn ID 1 つ。結果不明は照合し、別 ID で起動し直さない。
- CC-MGMT-INV-04: 処理済み位置は、判断または依頼の根拠に含まれたイベントまでしか進まない。
- CC-MGMT-INV-05: 停止した任務は新しい依頼・判断を受けず、実行中依頼の状態を保持する。
- CC-MGMT-INV-06: AI 由来だけの根拠は `allow_ai_only_evidence` を有効にした任務に限る。
- CC-MGMT-INV-07: `waiting_human` の解除と `human_gate_kinds` の依頼の評価は人間専用 (CC-INV-08)。
- CC-MGMT-INV-08: dots 専用の入口からは CC-MGMT-03 の 7 操作以外に到達できない。
- CC-MGMT-INV-09: 公開ホスト宛ての要求は Access の JWT を検証できない限り任務トークンの照合まで進まない。
- CC-MGMT-INV-10: OPEN は再起動で解除せず、解除までは新規受付・起動を防ぐ。実行済みの結果の記録は継続する。

## 実装

`src/management/domain.ts`: 型・入力規則・状態遷移・受付判断 (純関数)。
`src/management/repository.ts`: 任務・イベント・判断・依頼・処理済み位置の永続化と CAS。
`src/management/service.ts`: 任務管理・受付・判断・処理済み・成果・人間操作の use case。
`src/management/dispatcher.ts`: 払い出し・起動照合・終了観測の use case。
`src/management/runtime.ts`: spawn / inject / session 照合 port の組立てと寿命。
`src/management/prompt.ts`: 起動セッションへ渡す依頼文。
`src/api/management.ts`: dots 向け・受付口・成果・管理面の HTTP。
`src/mcp/management-server.ts`: dots 用 stdio MCP。
`src/bootstrap/core.ts` / `src/api/register-core.ts`: 寿命と経路の配線。
`src/discord/management.ts`: CDGD管理チャンネルのカード・ボタン・配達。
`web/src/pages/Management.tsx`: 任務と依頼の管理画面。
`src/management/remote-config.ts` / `src/management/remote-listener.ts`: dots 専用の入口の設定と寿命。
`src/management/cf-access.ts`: Cloudflare Access の JWT 検証。
遮断は `src/management/circuit-breaker.ts` (判定)、`circuit-breaker-repo.ts` (永続化)、
`circuit-breaker-service.ts` (ユースケース)、`src/api/autonomous-loop.ts` (HTTP) に分ける。
保存は migration 120 `management-sidecar`、配達記録は 121 `management-delivery`、自律設定と遮断は 151 `management-autonomy`。

## 未接続 (後続)

- Cf → Cc の変更通知は Cf PR #2219 で配備済み (コメント・返信・AI 要約・評価)。採否・ビルド・試遊結果は未対応。
- Di・Pf・Terpsichore の変更 push。
- dots から Cc への実接続 (接続済み PC での MCP 実行) の検証。公式資料上の前提: PC オンライン・ChatGPT アプリ起動中。

## 復旧

- 任務を止める: 管理面で stop。トークンを失効させるなら rotate。
- launch_unknown が残る: session 一覧で spawn ID を照合。期限後は自動で launch_failed になる。再実行は新しい request_key で人間か dots が依頼し直す。
- 機能ごと外す: runtime の配線を外しても table は残る (読取りのみ)。
