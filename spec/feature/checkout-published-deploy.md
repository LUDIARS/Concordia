---
type: feature
title: "checkout 前進後の deploy — checkout_published を受けて build と再起動へ繋ぐ"
description: "Revisor が登録 checkout を merge commit へ前進させた通知 (lifecycle event checkout_published) を既存の Revisor → Cc inject から拾い、Excubitor 登録のサービスがあるリポだけを build → Excubitor 再起動へ繋ぐ。実行有無は理由付きで 1 行残し、build/再起動の失敗はマージや checkout 前進を巻き戻さない。"
service: concordia
domain: checkout-published-deploy
owner: Concordia
tags:
  - revisor
  - deploy
  - excubitor
  - testing-claim
status: implemented
related:
  - ./testing-traffic.md
  - ./revisor-local-pr-submission.md
  - ./develop-confirm-flow.md
updated: 2026-08-21
---

# checkout 前進後の deploy

## 1. 問題

main が前進してもサービスは古いプロセスのまま動く。2026-08-09 の Genius がその状態で、
local PR #364 と #47 はマージ済みなのに稼働中のプロセスは `cd190cb` のビルドだった。

Revisor は「登録 checkout へ降ろすところまで」で終える設計
(Revisor `spec/feature/checkout-publication.md` §5)。 build と再起動へ繋ぐのは
Concordia の担当で、その経路 (cc-deploy: build → Excubitor 再起動) は既にある。
足りていないのは **降りたことを知って起動する部分**だけである。

## 2. 通知の受け口 (新しい通信路を作らない)

**Requirement ID: `SPEC-CHECKOUT-PUBLISHED-NOTICE`**

Revisor → Cc の通知経路は既にある (`POST /v1/sessions/:id/inject`, source=`revisor`)。
Cc 内部ではこれが `session.inject` イベントとして流れており、レビュー終局通知の購読が
既にそこへ張られている。 checkout 前進もこの経路に相乗りする。

- `src/deploy/notice.ts` — inject 本文から `checkout_published` を読む。
  イベント名 (`checkout_published`) を第一の手掛かりとし、日本語文面
  (「本体 checkout を … へ前進させました」) を補助とする。 どちらも読めなければ
  何もしない (fail-closed)。 見送り通知 `checkout_publish_skipped` は先に弾く。
  sha は PR ラベル (`repo#123`) が占める区間を除いた**全文**から探す。 PR 番号を sha と
  読まないためにラベルを外し、かつ Revisor 側の語順 (sha がラベルの前後どちらに出るか) に
  依存しないため。
- `src/deploy/watch.ts` — `session.inject` (source=`revisor`) を購読し、読めたときだけ
  deploy を起動する。 同じ前進の再通知で 2 回再起動しないよう、repo + 前進の識別子
  (sha、無ければ PR 番号) 単位で 10 分の重複抑止を持つ。 **どちらも読めない通知は
  抑止しない** — repo だけをキーにすると別々の前進が同じキーに畳まれ、2 本目以降が
  黙って落ちて「main は進んだのにサービスは古いまま」を作るため。 その場合は §3 の
  サービス単位の直列化に委ねる。 通知に repository が無い場合は対象セッションの
  `repo_path` のディレクトリ名で補う。

Revisor 側の event はまだ実装されていない (spec は draft)。 Cc 側は本文から読む形に
することで、Revisor の実装が入った時点で追加設定なしに動く。

## 3. deploy の実行 (既存ルールを変更しない)

**Requirement ID: `SPEC-CHECKOUT-PUBLISHED-DEPLOY-RUN`**

`src/deploy/deploy-service.ts`。 判断と実行の順は次のとおりで、途中で止まった場合も
必ず理由付きの結果を返す (例外を投げない)。

1. リポジトリを特定できない → `no_repository` で何もしない。 リポ名は通知本文
   (外部由来) から読むが、そのままクローン探索のパス片になるため、単一ディレクトリ名
   として安全でない名前 (`..`、区切り文字、ドライブレター等) も `no_repository` として
   弾く。 workspace root の外を本体クローンとみなさないため。
2. Excubitor 登録のサービスが無い → `no_service` で何もしない。 ライブラリ等では
   日常的に起きるので異常ではない。
3. 本体クローンが無い → `no_main_clone`。 **worktree からは build も起動もしない。**
4. 他セッションが同じサービスを testing claim 中 → `claim_conflict` で見送る
   (claim は advisory だが、再起動は他セッションの起動テストを巻き込むため)。
5. testing claim を出したうえで build (`release/build.ts`: build script が無ければ skip)。
6. Excubitor 経由で `restart`。 直接起動 (`npm run dev` 等) はしない。
7. 成否によらず claim を release する。

同一サービスへの deploy は**プロセス内で 1 本ずつ**に直列化する。 §2 の重複抑止は
repo+sha 単位なので、連続マージのように**別々の sha** が続けて降りると 2 本が並走しうる。
その 2 本は claim を同じ名義で取るため互いを `claim_conflict` として検出できず、
先に終わった方の release が後続の claim を消し、`npm ci` / `npm run build` も同じ
ディレクトリで衝突する。 claim (セッション間の advisory) では守れない範囲なので、
待ち合わせで直列化する。

起動・再起動が **Excubitor 経由・本体フォルダのみ・testing claim 付き**であることは
`spec/feature/testing-traffic.md` と cc-deploy の既存ルールであり、この機構はそれを
変更しない。

## 4. 記録 (無言にしない)

**Requirement ID: `SPEC-CHECKOUT-PUBLISHED-DEPLOY-RECORD`**

3 つの段階 — checkout 前進 / build / 再起動 — は独立に見えなければならない。
build や再起動の失敗は**マージや checkout 前進を巻き戻さない**。 失敗として報告する
だけにする。

- `src/deploy/outcome.ts` — 結果を「実行した / 見送った (理由) / 失敗した (段階と理由)」
  の 3 種として持ち、1 行の日本語表現を作る。 失敗文面には
  「マージと checkout 前進は成立したままです」を含める。
- `src/deploy/record.ts` — 結果は必ずログへ 1 行。 加えて chat の `system` channel へ
  1 行出す (他の投稿元と同じく insert の後に `chat.posted` を emit する — insert だけでは
  Web UI の chat ペインや各プラットフォームのミラーへ届かず、視認できる面が無言になる)。
  ただし `no_service` / `no_repository` は日常的に起きるためログのみ
  (spec の「サービスが無いリポでは何もしない」)。 失敗は `error.reported` にも出す。

## 5. 起動条件

`workflowBindings` の `review` キー (レビュー通知・Revisor 連携) に属する。
そのワークフローを無効にしている環境では購読自体を張らない。

## 6. この spec がやらないこと

- 自動マージ・自動 checkout 前進の判断 (Revisor 側の責務)。
- 再起動可否の判断ルールの変更 (共有インフラの lifecycle ルールはそのまま)。
- health 確認後の自動ロールバック。 失敗は報告に留める。

## 7. 検証観点

- サービス有り / 無し / 本体クローン無し / claim 衝突の 4 通りで、再起動が走るのは
  1 通りだけであること。
- build 失敗時に再起動が走らず、失敗として記録され、claim が残らないこと。
- 同じ前進が二重に届いても再起動が 1 回であること。
- source が `revisor` でない inject、checkout 前進以外の Revisor 通知で動かないこと。
- パス片として危険なリポ名 (`..` 等) がサービス解決にもクローン探索にも到達しないこと。
- 別 sha の前進が続けて届いたとき、build が重ならず claim を奪い合わないこと。
- 7 桁以上の PR 番号を sha と読み違えないこと (重複抑止のキーが壊れないため)。
- sha が PR ラベルより前に出る文面でも sha を拾えること (語順に依存しないこと)。
- sha を読めない別々の前進 (PR 番号違い) が 1 本に畳まれず、それぞれ deploy されること。
- chat へ出す結果が `chat.posted` として live な購読者へも届くこと。
