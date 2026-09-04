# 取引先・未公開プロダクト識別子を設定へ外出しする

- 日付: 2026-09-04
- 状態: 実装済み
- 発端: 公開リポの流出監査 (AIFormat `github-public-leak-audit.mjs`) で、
  `LUDIARS/Concordia` の追跡ファイルに登録語が 28,122 件見つかった。
  生成レポートの untrack とテストフィクスチャの中立名化で 46 件まで落ちたが、
  **7 件が製品コードに残った**。 これらは値を変えると機能が壊れる。

## なぜ設定へ出すのか

`LUDIARS/Concordia` は public。 取引先名・未公開プロダクト名がソースに直書きされて
いると、ぼかしでは消えない — 値そのものが動作に使われているので、置換すると
動かなくなる。 **値を設定 (DB / env) から読む形にすれば、ソースからは消え、
実際の名前は手元のインストールにだけ存在する。**

ぼかしは連鎖で考える必要がある。 テストや既定値から名前が消えても production の
判定値に残っていれば同じことなので、そこを最後に塞ぐ。

## 対象と現状

| 場所 | 値 | 変えると壊れる理由 |
|---|---|---|
| `src/delegation/parttimer-prompts.ts` | 請求 parttimer が叩くスラッシュコマンド名 | 存在しないコマンドを指すテンプレになり、起動しない |
| `src/delegation/parttimer-prompts.ts` / `src/delegation/seed.ts` | AI ノート parttimer の説明にある取引先名 | seed される説明文の実体。担当者が対象を特定できなくなる |
| `src/session-logs/project-dictionary.ts` | 正準プロジェクト名リスト (`PROJECT_NAMES`) | session-log のタグ付けに使う照合語彙。消すとそのプロジェクトのログが引けない |

対応済みでここには含めないもの:

- `harness.main_push_allowlist` の既定値 → **空配列**にした。 解決順は
  設定 UI → env → 既定シードなので、未設定なら「例外なし = 全リポで main 直 push を
  止める」という安全側に倒れる (許す方向には倒れない)。 既定値が
  `harness/main-push-allowlist.ts` と `config/settings/definitions/session.ts` の
  **2 箇所に重複していた**ので両方。

## 形

### 1. スラッシュコマンド名 → 設定 1 件

`delegation.invoice_skill_command` (string、既定 空)。

空のときは請求 parttimer のテンプレに**スキル呼び出しの行を入れない**。
未設定のまま存在しないコマンドを指す行を seed するより、行ごと無い方が
失敗が読みやすい。 値があるときだけ `/${command} ${month}` を差し込む。

### 2. 取引先名 → 設定 1 件

`delegation.partner_display_name` (string、既定 空)。 parttimer の説明文で
`${partner}` として展開し、空なら「取引先」という一般名詞へ落とす。

展開されないプレースホルダをテンプレへ残さない、という既存の規則に合わせる
(テスト「展開されない `${mention_user_id}` をテンプレへ残さない」と同じ考え)。

### 3. プロジェクト語彙 → 既存 registry から引く

`PROJECT_NAMES` のハードコードをやめ、Concordia が**既に持っている**
project code registry (`/v1/project-codes`、`src/db/project-codes-repo.ts`) を
正本にする。 現状のコメントにも「正本は CLAUDE.md / PROJECT-CODES.md」と
書いてあり、実態として二重管理のコピーになっている。

- `extractProjects(text, names)` は語彙を引数で受ける純粋関数のままにし、
  語彙の取得は呼び出し側 (`session-logs/reader.ts`) へ寄せる。
  純粋関数のテストは語彙を直接渡せるので、ダミー名で書ける。
- registry が空・取得失敗のときは**タグ付けしない** (空配列)。
  ハードコードへフォールバックすると外出しした意味が無くなる。
- `Ars` / `LUDIARS` / `infra` の除外は語彙側ではなく抽出側の規則として残す。
  「パスに遍在して全 log にマッチする」という理由は registry と無関係で、
  registry に載っていることと除外すべきことは別。

## 受け入れ条件

- `src/` の追跡ファイルに登録語が 0 件になること (監査で確認)。
- 請求 parttimer は、設定があれば従来どおりスキルを叩き、無ければその行を
  持たないテンプレを seed すること。
- session-log のタグ付けが registry 由来の語彙で従来と同じ結果を返すこと
  (registry に同じ名前が入っている前提)。 registry が空なら空配列を返すこと。
- 既存テストが実名に依存しなくなること。

## やらないこと

- **リポジトリ名そのもの**の変更 (`<org>/<repo>` 等)。 別の判断が要る。
- 履歴の掃除。 本設計は「これ以上ソースに書かない」ためのもので、公開済み履歴は
  `AIFormat/scripts/github-repository-reset.mjs` の prepare / migrate が担当する。
- spec 文書のぼかし (残り 39 件)。 機能に触れないので別途まとめて処理する。

## 検証

登録語 config はリポジトリ外に置く (neco 指示 2026-07-28)。

```
node AIFormat/scripts/github-public-leak-audit.mjs
    --org LUDIARS --workspace <workspace-root> --keywords-file <外部パス>
```

追跡ファイル側は上記で、公開済みコミットメッセージ側は
`github-public-history-audit.mjs` で見る。
