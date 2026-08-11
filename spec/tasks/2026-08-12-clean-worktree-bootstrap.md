---
task: clean-worktree-bootstrap
project: Concordia
kind: 実装
created: 2026-08-12
memory_links: []
---

# clean clone / worktree から npm ci が通らない

## 目的

`git worktree add` した直後の checkout で `npm ci` が失敗する。 新しい worktree を作るたびに
手作業の復旧が要る状態をやめ、 決まった 1 コマンドでビルドできる状態にする。

## 現象 (2026-08-12 実測)

新規 worktree で `npm ci` を実行すると、 依存解決の前に落ちる。

```
npm error enoent Could not read package.json:
  Error: ENOENT: no such file or directory, open '<worktree>\lib\vestigium\package.json'
```

`package.json` は `@ludiars/vestigium` を `file:lib/vestigium` で参照しているが、
`lib/vestigium` は git submodule なので、 `git worktree add` や `--recurse-submodules` 無しの
clone では空のまま残る。

さらに submodule を取得しただけでも `npm ci` は通らない。 vestigium の `prepare` が
`npx tsc` を呼ぶのに vestigium 側の node_modules が無く、 npx が tsc を解決できないため。
実際に通る順序は次のとおり (今回はこれを手作業で流した)。

```
git submodule update --init --recursive
npm ci --include=dev --prefix lib/vestigium   # dist を作る
npm ci --include=dev
```

`NODE_ENV=production` の環境でも devDependencies を導入するため、 `--include=dev` を明示する。
付けないと devDependencies が省かれ、 typescript が入らない。

同じ構造の問題は Cernere でも bootstrap スクリプトで解消済み。 そちらは submodule 取得 →
vestigium ビルド → 各パッケージ install を
1 コマンドにまとめ、 CI も同じ順序を踏む形にした。

## 完了条件

- submodule 未取得の clean worktree で、 追加の手作業なしにビルドが通る。
- `NODE_ENV=production` のシェルでも通る (bootstrap 側で devDependencies を明示する)。
- 手順が README に書かれ、 CI の順序と一致している。
- Revisor の登録テストが新しい worktree でも成立する (審査環境で同じ詰まり方をしない)。

## スコープ (編集可ディレクトリ)

- `scripts/` — bootstrap スクリプト
- `package.json` — bootstrap スクリプトの登録
- `README.md` — セットアップ手順
- `.github/workflows/` — CI の順序 (必要な場合)
