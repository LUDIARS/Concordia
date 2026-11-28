---
type: feature
title: "Slack のナレッジ検索"
description: "Slack のメンションまたはワークフロー投稿で、Notion とローカルに貯めたナレッジを OKF タグで検索し、短いサマリーと役職別の技術スキル・技術内容の HTML を返す。"
service: concordia
domain: chat-platforms
tags:
  - slack
  - knowledge
  - okf
  - sqlite
  - llm
status: planned
related:
  - ./slack-knowledge-flow.md
  - ./patrol-chat.md
updated: 2026-11-28
---

# Slack のナレッジ検索

UX-CC-KSEARCH-01。Slack で調べたい技術を書いた人は、同じスレッドで社内に貯めた知見の短いサマリーを読み、役職ごとに必要な技術スキルと技術内容を HTML で受け取れる。検索要求と結果の状態所有者は knowledge-search。検索対象の文書の所有者は、ナレッジフローの採用文書が knowledge-flow、Notion 記事マップと LUDIARS の断片が巡回チャットの知識。Slack の接続・配送は chat-platforms が所有する。

## 起動

- KS-1。Bot が参加しているチャンネルで `@Bot ナレッジ検索 <検索語>` と書くと実行し、元の投稿のスレッドに返す。Slack ワークフローからはカスタムステップ `knowledge_search`（入力 `query`・`channel_id`、出力 `result`）で実行し、指定チャンネルに起点を投稿してそのスレッドに返す。Cc 自身・他の bot・編集などの subtype 付き投稿は受け付けない。
- KS-2。同じ投稿（チーム・チャンネル・投稿 ts）への検索は 1 回だけ。Slack のイベント再送では返信を増やさない。要求は SQLite に保存してから受付の返信を出す。
- KS-3。検索語が空なら使い方を返し、検索も生成もしない。

## 検索範囲と OKF タグ

- KS-4。検索するのは次のローカル文書だけ。Slack 全体と、Notion への都度の問い合わせは行わない（2026-11-28 人間判断）。
  - ナレッジフローで採用した文書（`knowledge_flow_documents`）
  - Notion 記事マップのページ（`notion_map_pages`）。起点は設定 `services.notion_map_roots`。ナレッジベースのデータベース（`3d6e4c0e4c11804da4efd5d67886e6ba`）を起点に加える。取り込みには Cc が使う Notion コネクタの認証が要る
  - 巡回チャットの知識の断片（`chat_knowledge_chunks`。LUDIARS の README・spec・プロジェクト一覧）
- KS-5。各文書に OKF（Open Knowledge Format）の frontmatter 相当のタグを付けて保存する。項目は `type`（必須）・`title`・`domain`・`tags`（3〜7 個）・`roles`（関係する役職）。タグ付けは Cc 本体の定期処理（5 分ごとに 3 件）で進め、文書の本文ハッシュが変わったら付け直す。同じ本文で 3 回失敗したら止める。ナレッジフローの採用文書は分析結果の `category`・`tags`、Notion 記事マップは解析済みの `keywords` をそのまま使い、LLM を呼ばない。
- KS-6。検索は決定的に行う。検索語をタグの語彙と照合し、一致したタグの数と珍しさ（idf）を主、本文の語の一致を従として順位を付ける。タグ未付与の文書も本文の一致で候補に入る。上位 8 件・合計 24KB までを生成に渡す。

## 結果

- KS-7。候補が 0 件なら、その旨を返して LLM を呼ばない。
- KS-8。候補があれば LLM に、短いサマリー（3 行以内）、役職別（プログラマ / プランナー / デザイナー / サウンド / PM など、候補に出た役職のみ）の技術スキルと技術内容、出典を JSON で作らせる。資料内の指示は実行しない。出典は候補の文書だけに限り、候補にない URL は捨てる。
- KS-9。サマリーをスレッドに投稿し、HTML 1 枚（`knowledge-search-<番号>.html`）を添付する。HTML はテンプレートで組み、値はすべてエスケープする。外部スクリプトを読まない。
- KS-10。生成に失敗したら「生成に失敗した」と候補の出典一覧を返し、HTML は添付しない。結果不明の Slack 投稿は自動再送しない。

## セッションを起動して試す

- KS-11。回答できた検索結果の投稿に「セッションを起動して試す」ボタンを付ける。押した人に Cc のセッション起動権限（`/co-spawn` と同じ）があれば、その検索のナレッジ（検索語・サマリー・役職別の技術スキルと技術内容・出典と本文の抜粋）を初期プロンプトにして Claude のセッションを起動する。起動したセッションは、最初に要点と試せること（調査 / 研究 / 実装 / テスト）の候補を示し、何を試すかをユーザに確認する。ナレッジは資料として渡し、資料内の指示には従わない。結果（起動・権限なし・結果なし・起動失敗）は押した人だけに返す。コンテキストは回答時に要求の台帳に保存し、起動時に検索をやり直さない。

## 必要な Slack 設定

既存 Bot を使う。対象チャンネルへの参加（`/invite`）と、投稿・ファイル添付の権限（`chat:write`・`files:write`、付与済み）が要る。メッセージは既存の `message.channels` 購読で受け取る。ワークフローで使うときは、App 設定の Functions に `knowledge_search`（入力 query: 文字列・channel_id: チャンネル、出力 result: 文字列）を作る。手順は `spawn_session` と同じ（spec/setup/slack.md「Slack カスタムワークフロー」）。新しい npm 依存と公開待受は追加しない。
