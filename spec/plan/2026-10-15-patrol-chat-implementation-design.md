---
title: 既存巡回チャットの拡張設計と実装引継ぎ
id: CC-PATROL-CHAT-DESIGN
type: plan
status: implemented
service: concordia
domain: governance
updated: 2026-10-15
---

# 既存巡回チャットの拡張設計

本書は実装担当へ渡す設計。**2026-10-15 に実装した。実装済みの契約は [patrol-chat.md](../feature/patrol-chat.md)、残件は同書「残件」**。数値の初期値は設計案であり、ユーザーが数値を承認したという意味ではない。

依頼は「散歩とは別の巡回チャット。ルールで投稿を決め、Corpus 継承サービスの活動ログまたは Tendentia のトレンドから素材を選び、短い one-shot 雑談や報告を投稿する。返信には即応し、無返信ならリアクション数・後続投稿に応じて返す。LLM がルールを編集でき、Cc UI でルールと履歴が見えること」。後続の「実装が難しかったら Opus にやらせるから設計だけ作って」を受け、本ターンは設計引継ぎを完了範囲とする。

## 1. 実装方針

既存 `src/rules`、`rules` / `rules_log`、`/v1/rules`、Cc のチャット配信を拡張する。第二のスケジューラや別チャット製品は作らない。BT の Selector に相当する優先順位を純関数で表し、Utility の点数付けをその中で使う。BT ライブラリの導入は不要。

発火・優先順位・宛先・素材選択・頻度・打切りを LLM に決めさせない。素材を選んでから短文生成を最大 1 回だけ実行する。テンプレートモードは明示設定として提供し、生成失敗時に無言で切り替えない。セッションへの雑談タスク注入や curiosity-walk の探索は行わない。

### Histrio との整合

旧 `spec/feature/blackbox-chat-engine.md` は 2026-08-12 に判定・描画・persona の実装先を Histrio へ変更したと記す。一方、確認した Cc には稼働登録された rule engine と CRUD が残り、Histrio checkout は仕様中心で実装の稼働を確認できていない。移管完了とは扱わない。

今回の「既存が生きていれば拡張」に従い、Cc に現存するルール管理と実行台帳を使う。人格・長期記憶・複数エージェント会話は戻さない。本書の短文生成 port は Cc の one-shot adapter を初期実装とし、将来 Histrio が実装済みになれば adapter を交換できる形にする。Histrio を暗黙の必須依存にしない。実装 PR では旧 spec の冒頭へ「今回の素材起点巡回は Cc の既存 engine を拡張する」と追記し、旧 persona 移管方針まで取り消さない。

## 2. 確認済みの根拠

静的調査基点: Concordia `28958d23f464f394923e183c2c1e54b57e288dd4`。設計 worktree: `E:/Document/Ars/.wt-concordia-patrol-chat`、branch: `feat/patrol-chat-rules`。

| 現存する箇所 | 確認した事実 | 実装時の扱い |
|---|---|---|
| `src/rules/engine.ts` | tick/event/cooldown、runtime 停止、quiet-hours 制御。`fireOnce` は fire をログへ書くだけ | dispatch port と永続実行の呼出しを足す。fire を配達成功と解釈しない |
| `src/rules/decide.ts` | active session 条件、channel/intent 解決は決定的 | 純関数として拡張。未知条件・壊れた JSON を無条件発火へ変えない |
| `src/rules/review.ts` | trigger/channel/禁止パターン検証 | PUT/PATCH/enable/rollback で共通の実効設定レビュー |
| `src/api/rules.ts` | GET/PUT/PATCH/DELETE/toggle/log/assist | PATCH は現状 review を呼ばない。更新後全体の検証と楽観ロックを追加 |
| `src/db/rules-repo.ts` | 定義・変更ログ・last_fired 保存 | 実行と版の保存を別 repo へ分割。旧定義を勝手に大量有効化しない |
| `src/bootstrap/core.ts` | `startRuleEngine` を post-listen handle として登録 | 既存起動・停止系に配線。二重登録しない |
| `src/db/chat-repo.ts` | `chat_messages`、`in_reply_to`、metadata、内部 message ID | 同一 DB transaction で run と chat 行の関連を確定する |
| `src/events.ts` | `chat.posted` がある | event は起床通知。永続状態が正本 |
| `src/discord/reactions.ts` / `src/db/discord-repo.ts` | bot を除外して reaction を保存。fine/bad/other 集計がある | 所有 repo の読取 API を再利用。別の管理操作 reaction workflow を呼ばない |
| `src/discord/egress.ts` | chat を送信した応答 ID を `messageMap.put` で記録 | send 後・map 保存前の中断は結果不明。既存 map だけで exactly-once を保証しない |
| `src/discord/ingress.ts` | 一部経路に Discord reference → internal chat ID の解決がある | 汎用の巡回チャット返信取込が既に完成しているとは扱わず、meta-channel ingress を確認して接続 |
| `web/src/App.tsx` |現行 routes に Rules 画面なし | `/rules` と navigation を追加。既存 Settings の runtime toggle と連携 |

`GET /v1/rules` は引継ぎ元の読み取りで 200、旧 AI 作成ルールが多数残る。実際に投稿が動いている証拠ではない。

Praeforma: catalog 所有 endpoint の `/api/health` と `/api/projects` は 200。Concordia 登録 ID `01M1XZZMEXWTFCN4HKW8K7TJKM`、`uxGoalRevision=3`、`anatomiaRepo=concordia`、`gitUpdatedAt=2026-10-15T00:33:44.000Z` を確認。本機能の仕様版・人間承認は未取得。UX の正本は repo の `spec/ux/product.md`。

Anatomia: project list に `concordia` と本体 root の登録を確認。`ANATOMIA_HOME=E:/Document/Ars/.anatomia` を指定した `plan --project concordia --task ... --no-llm` と `context --project concordia --task ...` は終了コード 0。plan は既存 `concordia/governance` と `src/rules/engine.ts:startRuleEngine` を候補として返した。context には `.deployment-backups` の生成済み JS が混ざり、二つの無効な domain 定義を skip する警告もあったため、解析全体の正しさを保証せず本体ソースと突き合わせた。ローカルの `spec/domains/governance.domain.json` は `src/rules/[^/]+` を所有している。`blackbox-decision` は harness/taskflow の学習型判定層であり、名前が似ていても今回の所属ではない。

## 3. 価値・境界・不変条件

既存の支援 domain `governance` のルール制御を拡張する。会話配送は `chat-platforms`、HTTP は `http-interface`、UI は既存 Web 境界。新しい core domain とは呼ばない。実装時に変更した src/tests の membership と specRefs を対で補う。

UX: `UX-CC-PRODUCT` の「つぶやきと会話」、既存 `UX-CC-W4`（注意・コスト・配達）、`UX-CC-W5`（停止・復旧）。本機能の評価項目案を `UX-CC-PATROL-01` として feature spec に置く: 「素材の出典と投稿理由を確認でき、少ない消費で会話に参加できる」。未測定。

| ID | 不変条件 |
|---|---|
| CC-PATROL-01 | 判定に LLM を使わず、時刻・乱数・観測を入力として再現できる |
| CC-PATROL-02 | 投稿前に rule revision / trigger identity / material identity / destination / run を保存する |
| CC-PATROL-03 | 同じ trigger は一度だけ受理。結果不明の外部送信を自動再送しない |
| CC-PATROL-04 | 自分の出力を新しい素材・後続投稿・返信トリガーとして再投入しない |
| CC-PATROL-05 | scope と素材の共有範囲が宛先に適合する。個人用トレンドや非公開活動を共通 chat へ拡散しない |
| CC-PATROL-06 | runtime OFF / rule 無効化 / budget 超過 / lease 喪失後に新規生成・送信を開始しない |
| CC-PATROL-07 | 返信優先でも投稿回数・生成回数の上限を越えず、無返信追投稿を無限に続けない |
| CC-PATROL-08 | 編集は revision を増やし、実行は取得時の版を固定。無効化は固定版より優先する |
| CC-PATROL-09 | no material、source error、生成失敗、内部投稿、外部配達、結果不明を別状態で表示する |

併用: `CC-INV-02/03/04/06/07`、`CC-NODE-01/02/03/06/07/08/10`。本文・素材はデータであり、service 操作・シェル実行・作業依頼の権限にならない。

## 4. 素材の契約

下記は **Cc 内の新しい port**。外部サービスに現存する共通 API だと解釈しない。

```ts
type Material = {
  sourceId: string; itemId: string; version: string;
  kind: "activity" | "trend" | "service-event";
  serviceCode: string; featureKey?: string;
  occurredAt: string; observedAt: string;
  title: string; excerpt: string; url?: string;
  scopeKey: string; shareableTo: string[];
};
type SourcePage = {
  items: Material[]; cursor: string | null;
  observedAt: string; status: "ready" | "empty";
};
// auth / schema / timeout / unavailable は空配列でなく明示 error。
interface MaterialSource {
  list(query: { since: string; cursor?: string; limit: number;
    scopeKey: string; serviceCode?: string; featureKey?: string }): Promise<SourcePage>;
}
```

sourceId は allowlist のサービス登録を参照する。LLM が任意 URL、SQL、任意ファイル、credential を rule に書ける設計にしない。endpoint は所有サービスの catalog / 現行 discovery から解決し、認証は既存のサービス連携方式に従う。本文は長さ上限・秘密除外・共有範囲が確認できる summary だけ使う。

### Tendentia: 確認済みの入口

基点 `6a748f8dfd2d1387786544a40013e524f46beac0` の `src/trend/router.ts` に `GET /api/trend-crawler/overview` が存在し、`{ overview, busy }` を返す。`src/trend/types.ts` の `overview.genres[].sources[].items[]` に title/subtitle/url/metric/key/movement がある。source に sourceId/fetchedAt/error がある。

adapter はこの公開ランキング素材を正規化する。`sourceId + item.key + fetchedAt` を取得版、`sourceId + item.key` を話題同一性とする。共有可能範囲の元契約を確認し、個人の `/tendency`、interest、click 履歴を使わない。古い成功データが残る設計なので、source.error と fetchedAt を見て freshness を判定する。busy をエラーや成功時刻に読み替えない。Cc は refresh/crawl を起動しない。

ランタイムの認証成功・実際の overview 応答は未確認。loopback API でも runtime access-gate の契約を確認してから接続する。

### Corpus 継承サービス: 未確定の契約

Corpus 本体 `16a430fa97bce1f73a0a70050ef3fcd4811573ff` の `server` / `lib` / `spec` / `public/src` を `activity` / 活動ログで検索した範囲では共通 feed を特定できなかった。`src` はこの repo の入口ではない。これは「全継承サービスに存在しない」という証拠ではない。

実装担当は対象の継承サービスを一つ特定し、サービス所有の活動 API / plugin manifest / access scope / item ID / timestamp / pagination / retention を確認する。raw 運用ログ全量や sibling DB の直接参照で代用しない。共通 API がないなら、そのサービスの公開活動 read model への adapter を追加する。契約未確認の source は `unavailable: contract-unverified` と表示して選択不可にする。対応済みと偽る mock/no-op は禁止。

素材は最大 100 件/取得、本文入力合計 4 KiB、取得 timeout 5 秒を初期案とする。保存済み cursor から読み、新着・未使用・同一 scope・鮮度の条件を満たす候補だけ選ぶ。retry は素材読取に限り bounded backoff。認証失敗は毎秒再試行しない。

## 5. ルールの拡張

既存 rule ID を維持し、`config_version=2` と `revision`、型付き `action_config` を追加する。既存 conditions に巨大な設定を詰め込まない。旧 rule は CRUD/履歴を保持し、v2 の source/宛先/予算を設定しない限り新しい投稿副作用へ接続しない。旧「ログだけ」の全 rule が配備で突然投稿し始めないよう、実行モードを `legacy-observe` と明示する。

```json
{
  "id": "tendentia-tech-patrol",
  "expected_revision": 1,
  "config_version": 2,
  "trigger_type": "tick",
  "tick_sec": 1800,
  "cooldown_sec": 1800,
  "target": "chitchat",
  "conditions": [],
  "instructions": "素材から一つ、短い感想と出典を添える。",
  "action_config": {
    "kind": "material-chat",
    "source_ids": ["tendentia-public-trends"],
    "scope_key": "hq",
    "filters": { "genres": ["tech", "ai"], "max_age_sec": 86400 },
    "renderer": "oneshot",
    "max_chars": 240,
    "root_limit_per_day": 8,
    "llm_limit_per_day": 16,
    "followup": {
      "reply_enabled": true,
      "reaction_threshold": 3,
      "later_message_threshold": 4,
      "min_wait_sec": 600,
      "window_sec": 21600,
      "max_unprompted": 1,
      "max_replies": 4
    }
  }
}
```

この JSON は提案スキーマであり、現行 `/v1/rules` にそのまま送信しない。scope/destination は登録先の権限を検証する。LLM に任意 scope を自己承認させない。

機能・サービス単位の trigger は既存 `event` を使い、型付き `service_code` / `feature_key` / `event_kind` の filter を追加する。新しい normalized service event は永続 inbox 経由で受け、`source event ID` に unique 制約を置く。任意の未知 event 名を wildcard で受けてそのまま本文へ流さない。service-event は「短い報告」の template renderer を選べる。

PUT/PATCH/toggle-enable/rollback は同じ validator で、merge 後の全体を検証。revision 不一致は 409。actor は認証済み principal から記録し、request body の `actor=human` を信用しない。既存 assist は draft を返すだけを維持し、補完結果を勝手に保存・有効化しない。実装時に API auth の現状を確認し、既存認可より広げない。

## 6. 決定的な選択

1. 停止/所有権/scope/budget/無効化を検査。
2. 未処理の直接返信があれば優先。定期 tick と quiet-hours の確率待ちをしない。
3. 明示した service event の短い報告。
4. 条件を満たした無返信 follow-up。
5. 定期素材 pick。
6. 候補なしなら理由付き skip。

priority は上記の列挙順で固定。reply 同士は受信順。他候補は freshness、未使用、service filter の一致を整数 score にし、同点から注入乱数で選ぶ。候補が何件あって何点で選ばれたか、乱数 seed、選択 ID を run に保存する。素材選択は候補集合からランダム pick し、人気順 1 位への固定や選択のための LLM 呼出しを避ける。

再起動で全 tick rule が同時発火しないよう `next_due_at` と deterministic jitter を保存する。失敗した試行と最後の成功を `last_attempt_at` / `last_posted_at` に分け、現行 `last_fired_at` を成功の証拠にしない。

## 7. 返信・リアクション・後続投稿

会話単位を `conversation_id`（root chat ID と結び付く UUID）で保存する。source observation、rule revision、destination scope、expiry、直接返信回数、無返信追投稿回数を所有する。

- Discord reference と message map から `in_reply_to` を保存。Cc API の `in_reply_to` も同じ use case へ流す。直接返信は次 tick を待たず queue 先頭へ入れる。低優先の生成中なら並列生成を増やさず完了後に処理し、停止要求は別扱い。
- root またはその会話の直近 bot 発言への新しい人間の返信に対し、一つの inbound ID に一度だけ返す。過去の返信を再起動で再応答しない。多数の返信が同時に来た場合は最大 3 件まで一つの短文応答へまとめ、対応 ID を全部保存する。
- 直接返信の上限案は会話 4 回/6 時間。上限後は履歴に理由を出す。必要なら rule で変更可能だが hard cap も持つ。即時とは低優先スケジュールを待たないこと。LLM/配信の実時間ゼロは保証しない。
- 無返信 follow-up は、最後の bot 発言から最低 10 分経過し、直接返信がないときだけ。ユニーク反応ユーザー 3 人以上、または同じ宛先に後続人間投稿 4 件以上なら最大 1 回。初期案。
- 現行 `countByMessage` は reaction kind 別件数であり、ユニークユーザー数ではない。同一人の複数絵文字で閾値を越えないよう、所有 repo に distinct user 集計を追加する。remove も反映する。
- 後続投稿は internal ID cursor、author origin、宛先 scope で数える。自分、bot、system、別 conversation の自動発言、別 team/チャンネルを数えない。任意テキストの意味類似を LLM で判定しない。
- reaction は好意の確定ではない。bad が優勢なら追投稿を抑制。閾値を越えた後に取り消された場合は実行直前に再評価する。
- 返信が来たら予定していた無返信 follow-up を取り消す。expiry は返信待ちを義務的に催促する時刻ではなく、その会話を閉じる上限。
- 別 bot の返答へ自動返信を既定でしない。外部起源の peer AI を将来許すなら origin と depth を別設定し、人間の指示として扱わない。

## 8. 永続実行と配達

`rule_runs` が実行状態、`rule_conversations` が会話状態、`rule_versions` が設定履歴、既存 `rules_log` が短い監査一覧を所有する。DB migration は現在の migration ledger 方式に従う。DDL を起動ごとに場当たりで追加しない。

主な `rule_runs` 列: run_id、rule_id、rule_revision、trigger_key(unique)、conversation_id、scope_key、source_ref、material_snapshot、seed、decision/reason、status、lease_owner/lease_until、render_attempts、rendered_text、chat_message_id(unique nullable)、created_at/updated_at、error_code。

```text
queued → claimed → material_selected → rendering → rendered
       → skipped / failed                  ↓
                              chat_committed → delivery_pending
                                                ↓
                                  delivered / failed / delivery_unknown
```

生成は tools 無効・one-shot・入力上限・出力 240 字・時間上限 30 秒を案とする。生成結果を保存後、chat insert と run.chat_message_id の更新を同一 transaction にする。途中停止後は保存済み本文を使い、生成済み本文を再生成しない。生成中に落ちた run は費用結果不明を記録し、自動無制限再生成しない。

既存 chat eventBus は配送の起床通知に使う。**eventBus を durable outbox と呼ばない**。配達 adapter に chat ID/platform/destination で一意な送信試行台帳を足し、送信前に attempt を記録する。Discord の成功応答を受けたら external ID と run の配達状態を保存する。HTTP timeout / send 後の crash / map 保存失敗は delivery_unknown。単に map が空だから未送信と決めて再投稿しない。

利用 transport が documented idempotency key を保証しない限り exactly-once は主張しない。unknown は platform 上の message ID / 対象チャンネルの記録と照合できた場合だけ delivered へ進める。照合不能なら UI で「配達結果不明」を維持し、明示の再送は重複リスクと元 run を表示する。正常な送信失敗が確定した場合だけ同じ chat ID の配達を再試行する。

停止時は新規 lease 取得を止め、生成結果の保存を待ち、配達処理を drain して DB を閉じる。既存 EngineHandle.stop を Promise 対応へ変える場合は bootstrap の ResourceOwner と連動する。worker を追加せず、現行 engine 所有プロセスで DB CAS lease を使う。将来分離しても所有権喪失後の送信直前検査を維持する。

## 9. Cc API と画面

既存 `/v1/rules` を維持し、新規は同じ機能配下に追加する（以下は設計上の新 API）。

| API 案 | 用途 |
|---|---|
| GET `/v1/rules` | v1/v2、revision、実行可否と不足理由 |
| PUT `/v1/rules` / PATCH `/v1/rules/:id` | 検証付き追加・版付き更新 |
| POST `/v1/rules/:id/toggle` | enable 前に現在設定を再検証。disable は即時 |
| GET `/v1/rules/:id/versions` | 変更主体・差分・時刻 |
| POST `/v1/rules/:id/rollback` | expected_revision と復元元 revision。新 revision として保存 |
| GET `/v1/rules/sources` | 登録素材元、scope、ready/unavailable と最終取得時刻 |
| POST `/v1/rules/preview` | 副作用・LLM なしで候補と発火理由を表示 |
| GET `/v1/rules/runs?rule_id=&status=&cursor=` | bounded pagination の実行履歴 |
| GET `/v1/rules/runs/:runId` | 選択根拠・本文・配達・会話追跡・版 |
| GET `/v1/rules/log` | 既存互換。limit を整数 1〜200 に制限 |

`/rules` 画面を追加し、navigation から開く。上部に engine ON/OFF、予算、素材元の状態。下に「ルール」「実行履歴」の二つの表示。ルール行は trigger、service/feature filter、素材元、宛先、間隔、日上限、生成方式、最終結果、有効/無効。旧 rule は legacy-observe と明示する。

編集は型付きフォームを主体にし、LLM/上級利用者向け JSON も同じ schema で検証する。候補不足・認証不足を保存成功と混同しない。履歴には run ID、trigger、選んだ素材と出典、投稿本文、返信/反応/後続件数、skip/error reason、内部投稿と外部配達の区別を表示する。UI から任意コードや credential を入力させない。

rollback は設定のみ。過去の送信を取り消さず、既存 run の本文も書き換えない。無効化した rule は未着手 run を cancel、実行中は生成結果を保存して送信前停止。すでに送信したものは履歴を保持する。

## 10. 実装ファイルと順番

既存ファイルの括弧内に対応するテストを追加/拡張し、同じ変更単位で `cc.acceptance.json` implementations に source/tests/contracts を登録する。以下の新ファイル名は提案であり、まだ存在しない。

1. `spec/feature/patrol-chat.md`、既存 blackbox-chat spec の整合追記、governance membership/specRefs を更新。Actio の対応 task を確認して人間指示との task-link を登録する。
2. `src/rules/patrol-policy.ts`（同名 `.test.ts`）: source pick、priority、reply/followup、停止条件の純関数。`src/rules/patrol-config.ts`（同名テスト）: schema と実効検証。
3. `src/rules/materials/tendentia.ts` / `activity.ts`（各 `.test.ts`）: 外部契約の正規化。activity は所有サービス契約が確認できてから実装。
4. `src/db/rule-runs-repo.ts` / `rule-conversations-repo.ts` / `rule-versions-repo.ts`（各テスト）と正式 migration。claim/CAS、unique trigger、保存/復旧。
5. `src/rules/execute-patrol.ts`（同名テスト）: render → 保存 → chat commit。`src/rules/render-patrol.ts`（同名テスト）: one-shot/明示 template adapter。既存 CLI runner は timeout/cancel/費用記録を確認した上で再利用。
6. `src/rules/engine.ts` / `decide.ts` / `review.ts`（既存テスト拡張）: scheduling と execute port。`src/bootstrap/core.ts` で既存 engine にのみ配線。
7. `src/discord/ingress.ts` / `reactions.ts` / `egress.ts`、chat/reaction repo、必要な chat delivery adapter（契約テスト）: 巡回宛ての reply/reaction 観測・durable delivery。既存 session-message 配達台帳と chat_messages の ID 空間を混ぜない。
8. `src/api/rules.ts`（API テスト）: 全更新経路の review、revision、preview、sources/runs。`web/src/pages/Rules.tsx` と `web/src/pages/rules/*`（UI テスト）、`web/src/App.tsx`、navigation、API client。
9. 旧ルール移行・停止/復旧・unknown 配達の契約をまとめ、`cc.acceptance.json` の対応漏れを確認。配備前に旧 rule を明示的に v2 へ移す。既定一括投稿はしない。

上記は一つの利用可能な機能まで実装する順序。素材取得だけ、ログだけ、画面だけで全要件完了としない。Corpus 契約が見つからなくても Tendentia 経路と他の独立作業は進められるが、Corpus 対応は残件として明示する。

## 11. 受入条件とテスト計画

| 条件 | 必要な検証 | 対応 ID |
|---|---|---|
| 同じ入力/seed なら同じ選択。判定で LLM 0 回 | policy unit: fake clock/random、空/古い/別scope/既使用素材 | 01/05 |
| 定期・service/feature event の各 trigger で一つの短文 | application contract: material/render/chat ports、event dedupe | 01/02/03 |
| 直接返信は tick/quiet-hours を待たず priority が上がる | queue contract: reply と tick 同時、生成中reply、同じinbound再配信 | 03/07 |
| 無返信追投稿は閾値・経過・上限・宛先を満たす時だけ | distinct reaction/remove、後続ID、bot除外、reply到着競合 | 04/05/07 |
| 生成・送信中の停止/再起動で同じ root を増やさない | DB integration: 各保存境界 fault injection、lease CAS | 02/03/06 |
| send成功→map保存前 crash を再送しない | delivery contract: timeout/unknown/照合成功/照合不能 | 03/09 |
| API 編集で整合を迂回できない | PUT/PATCH/enable/rollback/assist、revision 409、未知条件拒否 | 05/08 |
| 旧定義が自動で投稿へ切り替わらない | migration/seed contract: AI旧rule、retired rule、legacy-observe | 06/08 |
| 実行理由・出典・版・配達結果が UI で分かる | UI: loading/error/empty/unknown、ページング、rev競合 | 09 |
| 投稿後も通常の人間指示/停止処理を妨げない | bounded queue、source timeout、runner cleanup の契約 | 06/07 |

テストコードを書くこととテストを実行する許可は別。今回、テスト・build・サービス起動/再起動・動作確認は実行していない。実装時も現行許可の範囲のみ。承認された起動テストは Excubitor 経由、本体フォルダ、事前 testing claim と終了後 release。worktree から起動しない。

## 12. Opus への引継ぎ

- 完了物は本設計文書。実行コード、DB migration、画面、テストは未作成。実装完了ではない。
- base / branch / worktree は §2。共有 main の既存未追跡ファイルへ触れていない。
- 編集前に worktree の実 branch と Cc session の repo_path/repo_origin/branch を再照合する。`lictor cli task set` だけでは repo binding が起動元 Castra のまま残ったため、正規 `lictor cli implement begin --cwd <worktree> --task '[Cc] ...'` で一致させた。
- この実行環境の通常 exec は `setup refresh had errors` だった。読み取りの `exec_command` を `require_escalated` で自動審査へ通すと成功し、本人の LICTOR_PORT が得られた。node_repl は env を継承しない。sidecar port/session ID を推測・別 session から流用しない。
- 作業中に policy の projectRoot/branch に起動元由来の通知が来た。直近の implementation bind 読戻しは worktree/Concordia origin/feature branch が一致。通知だけで無関係な repo に切り替えない。
- 対応 Actio task は未特定。引継ぎ元の `project=concordia` taskflow 読取 68 件には対象語の一致なし、本人 task-links は空。未登録と断定せず、別 task を代用しない。実装担当は現在の task 検索/指示参照で確認する。
- 最初の技術的確認は Corpus 継承サービスの活動 feed 契約と meta-channel の返信 ingress。未知 API を実在としてコード化しない。
- この設計は人間承認・実機評価済みではない。実装を開始してよいという元の依頼は存在するが、本ターンは後続指示に沿って設計で引き継ぐ。実装開始の再確認を機械的に求めない。
- 実装後の提出は Revisor local PR。GitHub feature push/PR、独自 merge/main 更新はしない。提出結果不明なら照合し、無条件再送しない。
