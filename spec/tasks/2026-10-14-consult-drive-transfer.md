---
task: 2026-10-14-consult-drive-transfer
project: Concordia
kind: 実装
created: 2026-10-14
taskflow_reference: actio:cc5d35c4-0876-4b51-a010-f2552eba93b2
memory_links: []
source_session: lictor-44fced54-664b-4ffc-8fb8-ec761f574d5b
followup_reference: actio:de584dfe-4c52-45ae-b875-e21dc9cbcb05
---
# 技術相談課: モデル・サウンドのファイル受け渡し (Google Drive)

設計正本: `spec/feature/tech-consultation.md` §6.4 (`SPEC-CONSULT-DRIVE-TRANSFER`)。Pf フラグメント 01M3XVA8BKK0JEYDSGFP1E9DM6、
2026-10-14 neco 判断「いったん Google Drive でいい」。
同日の追加指示「GoogleDriveは使用するユーザに編集可能な共有設定をかけてもらう感じです。」で、Cc がフォルダを作って共有する形から、
相談者が自分のフォルダを Cc のサービスアカウントへ編集者で共有する形へ変えた (追補、actio:de584dfe-4c52-45ae-b875-e21dc9cbcb05)。

### 目的

デザイナー・サウンドの相談者が、公開リンクに頼らずに 3D モデル・音声を相談へ渡し、直したファイルを受け取れる。

### 完了条件

- [x] 仕様 (tech-consultation.md §6.4) に節を足し、Pf の要件との対応・後始末 (フォルダは残す)・未実装 (サマリー画像・Synergos) を書く。
- [x] (#2974) 相談 1 件ごとに Drive フォルダを作り、相談者のアカウントにだけ編集者で共有する (リンク共有を作らない)。
  → 追補で置き換え: Cc はフォルダを作らず共有もしない。
- [x] (追補) `/consult files` は未設定なら「未設定」、設定済みならサービスアカウントのメールアドレスと共有の手順を相談者にだけ返す。
- [x] (追補) `/consult files folder:<URL か ID>` (相談者本人だけ) で、Cc が編集者として届くかを確かめてから相談に結び付ける。
  届かない・フォルダでない・閲覧者のみ・他の相談者の相談に結び付いているなら理由を返して結び付けない。
- [x] (追補) 結び付けはフォルダのアプリのプロパティ (`ccConsultationId`) で持ち、メールアドレスは受け取りも保存もしない。
- [x] (追補) 親フォルダの設定 (`services.google_drive_parent_folder_id`) とフォルダを作る・共有する経路を外す。
- [x] 相談者のファイル (3D モデル・音声) をデータフォルダの `transfer/incoming/` へ取り込み、`transfer/outgoing/` の回答を同じフォルダへ置く。
- [x] 鍵は設定画面の秘密 (schema_meta、secret-box) で持ち、未設定なら「ファイル受け渡しは未設定」と伝える (fail closed)。
- [x] Drive の REST をポートで包み、テストはモックで行う。依存パッケージは足さない。
- [x] `cc.acceptance.json`・Augur の台帳・契約 (consult-drive-C-1〜4) に対応付ける (追補で C-2 をフォルダの参照の読み方に、C-4 に結び付けてよいかを足した)。

### スコープ (編集可ディレクトリ)

- `src/consultation/` (drive-transfer-* / google-* / transfer-files-node)
- `src/api/consultation-drive.ts`、`src/api/register-core.ts`
- `src/bootstrap/consultation-drive-runtime.ts`、`src/bootstrap/core.ts`
- `src/discord/consult-drive.ts`、`src/discord/commands/consult.ts`、`src/discord/bot.ts`
- `src/config/settings/definitions/platform.ts`
- `spec/feature/`、`spec/tasks/`、`spec/domains/consultation.domain.json`、`cc.acceptance.json`、`augur.contracts.json`、`.augur/tests.jsonl`

### 再利用探索の採否

- 採用: Tabula 連携の秘密の持ち方 (`schema_meta` + secret-box、設定画面の 1 系統、`readMetaSetting`)、公開候補の「秘密は Cc 本体・Bot は Cc の API を呼ぶ」構成、
  相談者のデータフォルダ (`consultPersonalDataDir` / `isInConsultWorkspace`)、相談チャンネルの判定と権限 (`private_consultation_members`)。
- 不採用: `googleapis` / `google-auth-library` の追加。必要なのは Drive v3 の 7 呼び出しとサービスアカウントの JWT だけなので、`fetch` と
  `node:crypto` で書いた (依存パッケージは足していない)。Cc に既存の Google 連携 (OAuth) は無く、認証はサービスアカウントを既定にした。
- 不採用: 受け渡しの状態の DB 化。フォルダ・取り込み済み・回答の印は Drive のアプリのプロパティに持たせ、migration を足さない。
- (追補) 採用: 結び付けも同じアプリのプロパティ (`ccConsultationId`) に置く。既存の「状態は Drive が持つ」作りに合わせ、Cc 側に
  結び付けの記録 (テーブル) を足さない。探すときは親フォルダを使わず、サービスアカウントから届く全体 (`corpora=allDrives`) を印で探す。

### 検証

- `npm run build` (型検査を含む) 成功。`tsc -p tsconfig.test.json` は変更ファイルにエラーなし (main 既存の別ファイルのエラーは残る)。
- 変更したファイルに対応するテストだけ実行: 11 ファイル 90 件成功 (Drive はポートのモック・fetch の差し替えで検証。実際の Drive への接続はしていない — 認証情報が無い)。
- 未実施: 実 Drive での疎通、Discord 上での動作確認、サービスの再起動。
- (追補) `npm run build` と、変更したファイルに対応するテストだけを実行した (結果は PR 本文に書く)。

### 判断が要る点

- 後始末: フォルダは相談者のものなので Cc は消さない。相談の後始末で Cc が自分の共有 (サービスアカウントの編集者) を外すかは判断が要る。
- ツール制限のある相談 (`consult_tools: restricted`) は Read もシェルも持たないため、取り込んだファイルを開けない。相談者ごとの読み取りを
  許すか、デザイナー・サウンドの相談部署を `consult_tools: all` にするか。
- 運用の前提: 設定画面に鍵 (JSON) を入れるまでは「未設定」で動く。(追補) 相談者のマイドライブのフォルダにサービスアカウントが回答を
  置くと持ち主がサービスアカウントになり、容量を持たないサービスアカウントでは断られうる (未確認)。共有ドライブのフォルダを使ってもらうか、
  回答の返し方を変えるかは判断が要る。
- (追補) フォルダ ID を知っていれば、まだどの相談にも結び付いていない他人の共有フォルダを結び付けられる (他の相談者の相談に結び付いた
  フォルダは断る)。フォルダ ID は推測できない長さなので当面これで足りるとしたが、持ち主の確認が要るかは判断が要る。
- 未実装・今後: 修正内容のサマリー画像、Synergos の経路。
