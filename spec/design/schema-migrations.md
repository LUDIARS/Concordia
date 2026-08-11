# スキーマ migration の規律

## 規則

適用済みの migration は編集しない。 新しいテーブル・列・index は、 既存 migration を
書き換えず `MIGRATIONS` の末尾に番号付き migration を 1 件足す。 baseline
(`STATEMENTS` / `COLUMN_ADDITIONS` / `DELEGATION_COORDINATION_INDEXES`) も適用済みなので
同じ扱いで、 「新しいテーブルだから baseline に足しておく」 は禁止。

## なぜ

`runMigrations` は `schema_migrations` に保存した checksum と実装を突き合わせ、 食い違えば
起動を止める (`migration checksum mismatch at <version>:<name>`)。 これは正しい防御だが、
**発火するのは編集した時点ではなく、 次に誰かがサービスを再起動したとき**になる。
Concordia は dist 常駐なので、 編集者は自分が壊したことに気づけず、 別のセッションが
再起動した瞬間に起動不能になる。

実際に 2 回起きた。

| 日付 | 事象 |
|---|---|
| 2026-08-04 | baseline 編集 → 再起動で起動不能 |
| 2026-08-08 | 同じ経路で再発。 約 10 分停止 |

どちらも「新しいテーブルを baseline へ足した」もので、 規則は明文化されていたのに
機械的に守らせる仕組みが無かった。

## 仕組み

`src/db/migration-ledger.ts` が全 migration の checksum と、 適用後スキーマの指紋を凍結し、
`src/db/migration-ledger.test.ts` が実装から再計算した値と突き合わせる。

| 編集の型 | 捕まえるもの |
|---|---|
| baseline / 既存 migration の source を変える (= 起動不能になる編集) | 凍結 checksum との不一致 |
| source を据え置いて `up()` の SQL だけ変える | 適用後スキーマ指紋との不一致 |
| migration を足したのに凍結し忘れる / こっそり消す | 凍結エントリと実装の版一覧の不一致 |

指紋は関数本文ではなく `sqlite_master` から取る。 関数本文のハッシュはトランスパイラ
(tsx / esbuild / tsc) ごとに値が変わり、 偽陽性で落ちるため — 実測で tsx と vitest が別の
値を出した。

## 凍結値を書き換えてよいとき

- **新しい migration を足したとき**: 末尾にエントリを 1 件追加する。 既存エントリは触らない。
- **本番 DB の `schema_migrations` を同時に直すとき**: 復旧手順とセットでのみ。

テストを緑にするためだけに既存エントリを書き換えるのは、 時限爆弾を再装填する操作にあたる。

## 復旧手順 (起動不能になった場合)

1. 空の一時 DB に `applyMigrations` を全適用し、 正しい checksum 台帳を作る。
2. 本番 `schema_migrations` の該当行を `UPDATE` する。

起動失敗のログは `concordia.err.log` ではなく `concordia.out.log` に出る。 ESM namespace は
凍結されているため `runMigrations` の monkeypatch では回避できない (実測)。
