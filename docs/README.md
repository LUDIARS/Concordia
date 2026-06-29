# Concordia 公開サイト (GitHub Pages)

`spec/` の仕様書と `src/` の実装を突き合わせてレビューした結果をまとめた静的サイト。
ビルド不要（素の HTML/CSS/JS）で、`.github/workflows/pages.yml` が `main` への push 時に
GitHub Pages へデプロイする。

## ページ構成

| ファイル | 内容 |
|---|---|
| `index.html` | サービスの役割 / 主機能 / 設計指針 / provider 対応 |
| `architecture.html` | ドメイン一覧 + 依存関係のインタラクティブグラフ（`assets/graph*.js`） |
| `api.html` | REST / MCP / WS·SSE の API リファレンス。各エンドポイントはトグル展開で詳細・パラメータを表示（`assets/api-data.js`） |
| `review.html` | 仕様 ↔ コード 対応監査の結果 |

## データの出所

- `assets/graph-data.js` — `src/` の import 解析から得たドメインと有向依存エッジ。
- `assets/api-data.js` — `src/app.ts` / `src/api/*` / `src/mcp/*` / `src/events.ts` の実ルート定義から抽出。
- グラフ描画 `assets/graph.js` は依存ライブラリ無し（canvas force-directed）でオフラインでも動く。

## ローカル確認

```bash
cd docs && python3 -m http.server 8080   # http://127.0.0.1:8080/
```

## Pages の有効化（初回のみ）

次のどちらかで公開できる:

- **GitHub Actions**: Settings → Pages → Source を **GitHub Actions** に設定 → `pages.yml` がデプロイ。
- **ブランチ配信**: Settings → Pages → Source を **Deploy from a branch** にし、`main` ブランチの **`/docs`** フォルダを選択（Actions ワークフロー不要）。
