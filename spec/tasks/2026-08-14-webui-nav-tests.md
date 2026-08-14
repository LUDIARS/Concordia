---
task: webui-nav-tests
project: Concordia
kind: テスト
created: 2026-08-14
memory_links:
  - spec/tasks/2026-08-13-webui-sidebar.md
---
# WebUI サイドバーの表示切替テストを追加する

## 目的

2026-08-13-webui-sidebar の完了条件「表示切替 (デスクトップ / モバイル) のテストが
green」が未達。`web/src/components/Nav.tsx` を参照するテストが存在しない。

## 完了条件

- デスクトップ: サイドバー常駐と collapse 切替 (localStorage 永続・アイコンのみ表示)
  のテストが green。
- モバイル: hamburger → オーバーレイ開閉、route 変更 / Escape / backdrop クリックで
  閉じることのテストが green。
- web 側にコンポーネントテスト基盤が無い場合は、既存構成 (vitest) に合わせた
  最小構成の導入を含む。
- 既存の web ビルド・テストが green のまま。

## スコープ (編集可ディレクトリ)

- `web/`
- テスト設定ファイル (`web/package.json` / vitest 設定)
- root `package.json` / `package-lock.json` (下記制約のため jsdom の追加のみ)

## 制約: registered test は root vitest で走る

Revisor の registered test は repo root の `npm test` (root vitest) で実行され、
`web/` 配下のテストも同じ 1 回の実行に収集される。 vitest の environment
パッケージ (`jsdom`) は vitest 本体 (root `node_modules/vitest`) 起点の bare
import で解決されるため、 `web/package.json` の devDependencies だけでは届かず、
root の devDependencies にも `jsdom` (web と同版) が必要。

同様に、 root vitest 実行では `web/vitest.config.ts` の `setupFiles`
(`web/src/setupTests.ts` = jest-dom マッチャ登録) も読まれない。 そのため
jest-dom のマッチャ登録は `Nav.test.tsx` 自身の先頭で
`import "@testing-library/jest-dom/vitest"` して行う (web ローカル実行・root
実行のどちらの config でも有効になる自己完結型)。
