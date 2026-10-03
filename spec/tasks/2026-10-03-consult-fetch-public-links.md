---
task: 2026-10-03-consult-fetch-public-links
project: Concordia
kind: 実装
created: 2026-10-03
memory_links: []
---
# 相談窓口: 公開 Notion / Google Drive のリンク取得を許し、相談セッションへのブランチ切替の案内を止める

設計正本: `spec/feature/tech-consultation.md` §6 (この task で更新する)。
2026-10-03 neco 指示:
- 「相談時にもらった Notion のオープンなリンクを取得できるようにする。Canalis クローラーと対応するスキルを使用する。Castra にあるものをコピーして使用してよい」
- 「相談時にもらった Google Drive を開いてデータを取得できるようにする」
- 方式は neco 選択「B + 公開のみ」(相談セッション側で取得スクリプトを実行する。Drive は「リンクを知っている全員」の公開リンクだけ)
- 「相談窓口へのブランチ切り替えは通知しないでください」

- 価値: UX-CC-W6 / シナリオ UX-CC-S7
- ドメイン: consultation (取得の許可)、testing-claims (ブランチ切替の案内)
- 不変条件: CC-CONSULT-INV-07 (ツールを Web 検索・ToDo・スキルと取得コマンド 1 本に限る)

## 目的

相談者が「この資料を見て」と公開リンクを送っても、相談セッションは Web 検索しか使えず中身を読めなかった。
取得スクリプト 1 本だけを実行できるようにし、それ以外のコマンドは今までどおり使えないままにする。
相談セッションには開発用のブランチ切替の案内が届いていた (相談者の Discord スレッドに出る) ので止める。

## 設計

1. 取得スクリプトとスキルは相談フォルダのリポ (`E:/Document/Consult`) が持つ (別リポ、同日に追加済み):
   `_source/tools/fetch-link/fetch-link.mjs` と `_source/skills/consult-fetch-link`。Notion は loadPageChunk API、
   届かないときだけ Canalis notion-public の写しで描画。Drive は書き出し URL / 直接ダウンロード / フォルダの埋め込み表示。
2. `src/consultation/consult-fetch-link.ts` (新規): スクリプトの場所 (`consultFetchLinkScript`)、起動 env 名、
   claude の permissions (`consultClaudePermissions`: dontAsk + allow 4 件)。
3. `projectless-consult.ts`: `--tools` に Bash を足し、`consultWorkspaceClaudeSettings` に permissions を載せる。
   初回指示の作業範囲の説明に取得コマンドを書く。`isInConsultWorkspace` を足す。
4. `projectless-consult-launch.ts`: 起動 env に `CONCORDIA_CONSULT_FETCH_LINK_SCRIPT`。port `codexPreToolHookTrusted` で
   `codexFetchLinkReady` を決める (ログイン済み かつ フック信頼済み)。
5. `consult-codex-home.ts`: config.toml の `[hooks.state.'<hooks.json>:pre_tool_use:N:M']` の trusted_hash を読む。
6. `consult-model.ts`: `confinementArgsFor(..., { codexShell })` で `--disable shell_tool` を外す。
7. `tools/consult-fetch-link-command.mjs` (新規) + `tools/consult-codex-hook.mjs`: シェルは取得コマンドの形だけを通し、
   ほかは Cc に聞かずに止める (Cc に届かなくても止める)。
8. `src/testing/branch-watch.ts`: `isExempt` を足し、`bootstrap/core.ts` で相談の置き場所の中のセッションを除く。

## やらないこと

- 取得結果の要約や初回指示への自動の載せ込み (案 A は採らなかった)。
- サービスアカウントでの Drive 読み取り。
- codex の sandbox を緩めること (`-s read-only` のまま)。

## 受け入れ条件

- [x] 相談の claude は WebSearch / TodoWrite / Skill / 取得コマンドだけを許され、ほかは dontAsk で拒否される設定が書かれる。
- [x] codex のフックは取得コマンド以外のシェル (つなげたコマンド・展開・別スクリプト・ファイルのパス) を止める。Cc が無くても止める。
- [x] codex はフックが信頼済みのときだけシェルを残す。未信頼・未ログインなら従来どおり外す。
- [x] 相談の置き場所の中のセッションにはブランチ切替の案内を出さず、ほかのセッションには出す。
- [x] spec §6 と CC-CONSULT-INV-07 の強制箇所が実装と一致する。

## 復旧

- 取得を止める: `PROJECTLESS_CONSULT_CLAUDE_ARGS` から Bash を外し、`confinementArgsFor` の codexShell を常に false にする。
  状態は持たない (役職フォルダの settings.local.json は起動ごとに書き直される)。
- 案内を戻す: `bootstrap/core.ts` の `isExempt` を外す。

## 実施結果

### 再利用探索

- 取得は Canalis の `src/crawl/notion-public` (Playwright) を相談フォルダへ写した。ただし notion.site は描画すると Cloudflare の
  確認画面で止まり本文に届かなかった (2026-10-03 実測) ため、主経路は Notion の読み取り API にし、描画は予備に回した。
- codex のフックは既存の `tools/consult-codex-hook.mjs` に判定を足した (新しいフックは作らない。hooks.json の定義は変えないので信頼は保たれる)。
- 判定のパスは既存の `consultWorkspaceClaudeSettings` / `confinementArgsFor` / `startBranchWatch` に引数・依存を足した。

### 検証

- 実施: `tsc --noEmit` (エラー 0)。vitest で変更した 8 ファイル (51 件) が通過。
- 実施: 取得スクリプトの実取得 — 公開 Notion ページ (Notion Official、相談スレッドに貼られた notion.site のポートフォリオ) と
  公開スプレッドシート (Google のサンプル) が読めた。非公開・存在しない Drive は理由付きで「取得できませんでした」。
- 未実施: 相談セッションでの実地確認 (セッションの動作テストはハーネスで禁止)。codex の read-only sandbox で通信が通るかは未確認。
