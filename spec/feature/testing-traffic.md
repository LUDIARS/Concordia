# テスト交通整備 (testing traffic control)

再起動・起動テストの運用ルールを Concordia が管理・交通整備するための機構。

## ルール (運用合意 2026-07-02)

- サービスの再起動・起動テストは **Excubitor 経由** で、 **プロジェクト本体フォルダ
  (`E:/Document/Ars/<Repo>`)** のみで行う。 worktree / 複製フォルダからの起動は禁止。
- サービスをテストする前に Concordia へ **一報 (claim)** を入れる。 「いま何がテスト中か」
  の正本は Concordia が持つ。

## API

| verb | path | body | 説明 |
|---|---|---|---|
| POST | `/v1/testing/claim` | `{session_id, service, branch?, note?}` | テスト開始を宣言。 同一サービスを他セッションがテスト中なら `conflicts` に返し、 **双方へ警告 inject** する (advisory — 強制ロックはしない)。 |
| POST | `/v1/testing/release` | `{session_id, service?}` | テスト終了。 service 省略で全解放。 |
| GET | `/v1/testing` | - | active な claim 一覧。 |

- claim はセッション終了/喪失 (session.ended / session.lost) で自動解放。
- 放置 claim は TTL (60 分) で active から外れる。
- テーブル: `service_test_claims` (schema.ts)。

## note の文字コード検証

**Requirement ID: `SPEC-TESTING-CLAIM-NOTE-ENCODING`**

`claim` の `note` に U+FFFD (REPLACEMENT CHARACTER) が含まれていたら **400 で拒否する**。
理由と送り直し方を `detail` に返し、呼び出し元が同じ壊れ方で再送しないようにする。

- U+FFFD は「デコードに失敗した」痕跡であり、**元のバイトは既に失われている**。
  受け取って保存すると復元不能な文字列が正本に残る。
- 実際の混入経路は Windows / Git Bash から `curl -d '{"note":"日本語"}'` と
  **argv へ直接埋め込む**送り方。MSYS の argv 変換で非 ASCII が潰れる
  (UTF-8 ファイル + `curl --data-binary @file.json` なら無傷)。
- 破損した claim が保存されると、壊れた文字列が黙って蓄積する。保存せず入口で
  fail-fast する。
- 実装: `src/shared/text-integrity.ts` (検査) / `src/api/testing.ts` (ClaimSchema で拒否)。
- 既存レコードの遡及修復は行わない。

## 投稿

testing claim の開始・再宣言・明示解放・セッション終了時の自動解放は、
`operational.claim.opened` / `operational.claim.released` として公開する。Discord と Slack は
対象 session のチャンネルへ lifecycle を投稿し、service、branch、note、競合件数を共有する。

これは人が調整に使う advisory claim の通知面である。delegation queue の lease や Lictor の
transcript file claim など、実装内部の排他・fencing claim は投稿対象に含めない。

## ツール監視 inject (branch-watch)

プロンプトフックでの毎回注入は非効率なので、 セッション行の branch (Lictor が変化時に
PATCH する) を 30 秒間隔で監視し、 **ブランチ切替を検知したセッションにだけ** 運用ルール
(Excubitor 経由 + 本体フォルダ + 一報) を inject する。

- テスト claim 宣言済みのセッションには出さない (既に一報済み)。
- 同一セッションへの再通知は 60 分クールダウン。
- 実装: `src/testing/branch-watch.ts` / 通知経路: `src/testing/notify.ts`
  (session_events `inject` 記録 + eventBus `session.inject`)。

## セッション側の使い方 (/cc-test スキル)

```bash
# テスト開始前
curl -s -X POST http://127.0.0.1:11111/v1/testing/claim \
  -H "content-type: application/json" \
  -d '{"session_id":"<自分の session_id>","service":"<サービスコード>","note":"何をテストするか"}'

# 終了後
curl -s -X POST http://127.0.0.1:11111/v1/testing/release \
  -H "content-type: application/json" \
  -d '{"session_id":"<自分の session_id>"}'
```

conflicts が返ったら、 相手セッションと作業がぶつからないよう調整する
(相手にも同じ警告が inject されている)。
