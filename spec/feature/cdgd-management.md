---
title: CDGD マネジメント層 (dots サイドカー)
id: CC-MGMT
status: draft
---

# CDGD マネジメント層 (dots サイドカー)

2026-10-01 neco 指示: 「CDGD のマネジメントレイヤに dots を配置する / Cc サイドカーに置く」の
実装設計 (Codex セッション lictor-76713395、2026-09-30〜10-01) をレビューして実装する。
同日追記: **dots の管理は Cc がやる**。

dots は CDGD 全体を継続して見る横断判断者で、Cc と並ぶ論理的なサイドカーに置く。
dots が持つのは「観測・判断・依頼・成果の追跡」だけで、実装・Pf 更新・Di 議論・返信配送・検証は
Cc と Cc が起動したセッションが行う。dots は各サービスへ直接書き込まない。
**任務 (mission)・資格情報・判断記録・依頼・処理済み位置は Cc が所有する**。dots の記憶は補助で、
再開時は Cc から読み直す。

## 価値・所属

UX-CC-W2/W4/W5、UX-CC-S2/S3/S5。失うと困る状態は任務の範囲と停止、dots の判断理由、
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
| R6 | AI 返信の再取り込み防止が文面だけ | イベントに origin (human/ai/system) と親依頼 ID を必須で持たせ、根拠が AI 由来だけの依頼を拒否する |
| R7 | 上限 (同時数・回数・費用) の強制が無い | 任務の同時依頼数・日次依頼数で拒否、Cc のコスト上限中は起動を保留 |
| R8 | 受入・効果確認を誰が付けるかが無い | 成果記録は担当セッション本人だけ、受入・効果確認は人間の管理面だけ。dots のトークンでは呼べない |
| R9 | dots からの即時起動 API・イベント push は検証前 | 初期版はポーリングのみ。dots の継続任務から `changes` を読む |

## 契約 CC-MGMT-01 任務 (Cc が管理する)

- 任務は名前・部署 (CDGD)・対象プロジェクト (1 件以上)・目標・許可する依頼種別・人間判断へ戻す依頼種別・
  効果確認の要否・同時依頼数上限 (既定 3)・日次依頼数上限 (既定 10)・確認間隔の目安・状態 (active/stopped) を持つ。
- 作成・更新・停止・再開・トークン回転は人間の管理面 (`/v1/admin/management/*`) から行う。
  管理面は他の `/v1/admin/*` と同じ loopback 信頼境界で、同じ PC の AI セッションも到達できる (既存と同じ制約)。
  トークン平文は作成と回転の応答でだけ返す。
- 停止中の任務は新しい依頼・判断を受け付けない。読取りと実行中依頼の状態は保持する (CC-MGMT-INV-05)。

## 契約 CC-MGMT-02 変更の受付と配信

- `POST /v1/management/events` (loopback): `{event_key, source, kind, project_code, origin, summary,
  target_key?, parent_request_id?, ref_url?, observed_at?}`。event_key で冪等、同じキーで内容が違えば 409。
- 依頼の状態遷移は Cc が source=`cc`、origin=`system`、parent_request_id 付きで同じ列へ積む。
- `changes` は任務の対象プロジェクトのイベントを seq 昇順で返す。応答に出所ごとの最終受信時刻を含める。

## 契約 CC-MGMT-03 dots 向け API (Bearer トークン)

| 操作 | HTTP | MCP tool |
|---|---|---|
| 文脈 | `GET /v1/management/context` | `read_management_context` |
| 変更 | `GET /v1/management/changes?after=&limit=` | `read_management_changes` |
| 判断記録 | `POST /v1/management/decisions` | `record_management_decision` |
| 依頼 | `POST /v1/management/requests` | `submit_management_request` |
| 依頼照会 | `GET /v1/management/requests/:key` | `get_management_request` |
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
2. 根拠が全て origin=ai なら拒否 (`evidence_ai_only`)。
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

## 契約 CC-MGMT-05 成果・受入・効果確認

| 状態 | 意味 | 遷移させる主体 |
|---|---|---|
| execution_finished | セッションが終わった | Cc (session 観測) |
| outcome_recorded | 成果の要約と参照が保存された (= 受入待ち) | 担当セッション本人 `POST /v1/management/requests/:id/outcome` |
| accepted | 受入済み。効果確認が要る任務では効果確認待ち | 人間 (管理面) |
| effect_confirmed / effect_not_met | 狙った改善の確認結果 | 人間 (管理面) |
| rejected | 人間判断で却下 (waiting_human から) | 人間 (管理面) |

dots はセッション終了・成果記録を完了扱いしない。受入・効果確認は代行できない。

## 契約 CC-MGMT-06 人間の管理面 (Web / Discord)

2026-10-01 neco 指示「上から順に対応」の 2 件目。
- Web `/management`: 任務の一覧・作成・停止・再開・トークン回転 (平文は応答時だけ画面に出し、保存しない)、
  依頼の一覧と人間操作 (承認・却下・受入・効果あり・効果なし)。操作者名を入力して記録する。
- Discord 本社 guild の `CDGD管理` チャンネル: 人間が見るべき状態 (waiting_human / launch_failed /
  execution_finished / outcome_recorded / 効果確認待ちの accepted) になった依頼をカードで出す。
  以後の状態変化は同じカードを編集する。ボタンは状態で許される操作だけを有効にし、操作者は
  `discord:<user id>` で記録する。押せるのはセッション起動権限を持つ人だけ (雑務と同じ判定)。
- 配達は依頼の revision ごとに記録する (`delivered_revision` / `discord_message_id`)。保存してから配達し、
  配達失敗は依頼の状態を変えず次の周期で再送する (CC-INV-06)。
- これらの経路は `/v1/admin/management/*` を使い、dots のトークンでは呼べない (CC-MGMT-INV-01)。

## 契約 CC-MGMT-07 dots 専用の入口 (リモート PC 向け)

2026-10-01 neco 判断「専用入口を作る」。dots の接続先がリモート PC のとき、Cc 本体の
`127.0.0.1:11111` には届かない。トンネルで 11111 を晒すと loopback 信頼の管理 API まで届くので、
dots 用の 6 操作 (CC-MGMT-03) だけを通す別 listener を立てる。

- 既定 OFF。`CONCORDIA_MANAGEMENT_LISTEN=1` で有効、`CONCORDIA_MANAGEMENT_LISTEN_HOST` (既定 127.0.0.1) と
  `CONCORDIA_MANAGEMENT_LISTEN_PORT` (有効時は必須、暗黙の既定ポートを作らない) で待ち受ける。
  ポートの正本は Concordia の Excubitor catalog。変更は再起動で反映する。
- 通すのは `/v1/management/{context,changes,decisions,requests,requests/:key,acknowledge}` だけ。
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

## 不変条件

- CC-MGMT-INV-01: dots のトークンで呼べるのは CC-MGMT-03 だけ。サービスへの書込み・受入・承認経路を持たない。
- CC-MGMT-INV-02: 同じ request_key / event_key / decision_key は 1 件。再送は同じ結果を返す。
- CC-MGMT-INV-03: 起動は依頼 1 件につき spawn ID 1 つ。結果不明は照合し、別 ID で起動し直さない。
- CC-MGMT-INV-04: 処理済み位置は、判断または依頼の根拠に含まれたイベントまでしか進まない。
- CC-MGMT-INV-05: 停止した任務は新しい依頼・判断を受けず、実行中依頼の状態を保持する。
- CC-MGMT-INV-06: 根拠が AI 由来だけの依頼は受け付けない。
- CC-MGMT-INV-07: waiting_human は人間の管理面の操作でしか解除しない (CC-INV-08)。
- CC-MGMT-INV-08: dots 専用の入口からは CC-MGMT-03 の 6 操作以外に到達できない。
- CC-MGMT-INV-09: 公開ホスト宛ての要求は Access の JWT を検証できない限り任務トークンの照合まで進まない。

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
保存は migration 120 `management-sidecar`、配達記録は migration 121 `management-delivery`。

## 未接続 (後続)

- Cf → Cc の変更通知は Cf PR #2219 で配備済み (コメント・返信・AI 要約・評価)。採否・ビルド・試遊結果は未対応。
- Di・Pf・Terpsichore の変更 push。
- dots から Cc への実接続 (接続済み PC での MCP 実行) の検証。公式資料上の前提: PC オンライン・ChatGPT アプリ起動中。

## 復旧

- 任務を止める: 管理面で stop。トークンを失効させるなら rotate。
- launch_unknown が残る: session 一覧で spawn ID を照合。期限後は自動で launch_failed になる。再実行は新しい request_key で人間か dots が依頼し直す。
- 機能ごと外す: runtime の配線を外しても table は残る (読取りのみ)。
