# 技術相談 — 事前ヒアリング・プライベート相談・Tabula への公開

> 2026-09-30 neco 指示:「技術相談課の相談は、事前情報として『何について知りたいか』『説明にあたっての
> 技術レベル』『あなたの役職』を取得し、可能な限り『目的』を問う (知ることが目的の問いもあるので問題はない)」
> 「プライベートでブロックするものも作りたいのでフォーラムではないやり方。プライベート設定を作り、
> プライベートの場合はコマンドで投稿して専用カテゴリにプライベートチャンネルを自動作成。必要な権限者を
> 自動追加し、本人・追加された管理者・任意で招待した人が見られる」「共有したい情報でセンシティブでないものは
> オープンにする提案を AI が行う。オープンになった情報は Tabula に投稿」。
> 設計は director case `dir_687ecaf4` plan v1 を推奨案のまま承認 (同日)。

- 価値: [UX-CC-W6](../ux/product.md) / シナリオ UX-CC-S7
- 関連: [部署](departments.md) (部署設定・部署フォーラム)、[対話の前提データ](dialogue-context.md)
  (ユースケース・依頼者メモ・起動ブロック)、[社員名簿](staff-roster.md) (権限者の判定)

## 1. 用語

| 用語 | 意味 |
|---|---|
| 事前ヒアリング | 回答を始める前に揃える 4 項目: 知りたいこと・技術レベル・役職・目的 |
| オープン相談 | 部署フォーラムへの投稿で始まる相談。スレッドは guild の誰でも見られる |
| プライベート相談 | `/consult` で始まる相談。閉じたテキストチャンネルで行う |
| 権限者 | 部署設定で自動追加される閲覧者。既定は社員名簿の管理職以上 |
| 公開候補 | 相談から AI が書き直した、全体に共有してよさそうな知見の要約 |

## 2. 不変条件

| ID | 条件 | 強制箇所 (実装時に確定) |
|---|---|---|
| CC-CONSULT-INV-01 | プライベート相談チャンネルは作成と同時に閉じる (作成後に閉じる隙間を作らない) | チャンネル作成時の permission overwrites |
| CC-CONSULT-INV-02 | 閲覧できるのは本人・権限者・招待された人・Bot だけ。招待・除外は本人か権限者だけ | 招待コマンドの判定 + overwrites |
| CC-CONSULT-INV-03 | プライベート相談の本文・思考・カードは共有面 (フォーラム・activity・monitor・pr-queue・連合) に出さない | 出力の配送判定 |
| CC-CONSULT-INV-04 | Tabula への公開は相談者本人が承認した要約だけ。承認前の候補は外へ出さない | 公開ボタンの判定 |
| CC-CONSULT-INV-05 | ヒアリング内容と依頼者メモはローカル DB だけに置き、連合・通知・ログへ出さない | 既存の依頼者メモの規則 (dialogue-context.md §7) を継承 |
| CC-CONSULT-INV-06 | 子会社でプロジェクト無しに起動できるのは、担当プロジェクトを持たず稼働中の読み取り専用ユースケースを持つ部署だけ | `isProjectlessConsultDepartment` (Bot の受付・admin spawn の両方) |
| CC-CONSULT-INV-07 | その起動は本社の作業領域を cwd にしない。役職ごとの作業ディレクトリに固定し、要求側は場所・引数・provider を選べない。ツールは Web 検索・ToDo・スキルと、公開リンクの取得コマンド 1 本だけ (2026-10-03) | `resolveProjectlessConsultLaunch` + admin spawn、`consultClaudePermissions` (claude)、`isAllowedFetchLinkCommand` (codex のフック) |
| CC-CONSULT-INV-08 | 相談セッションは上位の CLAUDE.md / AGENTS.md と自動メモリを読まない (社内のプロジェクト名を回答に持ち込まない。Castra のメモリやワークフローを引き継がない) | 役職フォルダの `.claude/settings.local.json` (`claudeMdExcludes` / `autoMemoryEnabled:false`) + `CLAUDE_CODE_DISABLE_AUTO_MEMORY` |
| CC-CONSULT-INV-11 | 相談セッションは provider に関わらず、役職フォルダの指示 (AGENTS.md とスキル。移行前は CLAUDE.md) を受け取る。載せるのは役職フォルダ自身のものだけ (上位のフォルダ・相談者のデータフォルダの中は読まない) | claude は自分で読む。codex は AGENTS.md を自分で読み、読めない分 (スキル本文・移行前の CLAUDE.md) は admin spawn が初回指示に載せる (`needsInlineRoleGuidance` / `buildRoleGuidanceBlock` (`src/consultation/role-guidance.ts`)、`loadInlineRoleGuidance` (`src/consultation/role-guidance-files.ts`)) |
| CC-CONSULT-INV-10 | 相談は FINAL ANSWER 以外を投稿しない (前提質問・状態カード・後始末の共有確認は除く) | 部署の `output.*` を状態カード以外 off。`relay-output-filter.ts` (session.message と chat 経路)、`session-end-output.ts` (終了時の自動指示と独白) |
| CC-CONSULT-INV-09 | 共有の問いは閉じた相談に 1 回だけ出し、公開は本人の「共有する」だけ。判定できない・要約に秘匿語や Cc のプロジェクト名が残る・子会社は問わない | `ConsultationClosureService` (wrap_status を条件付きで進める) |

## 3. 事前ヒアリング

**Requirement ID: `SPEC-CONSULT-INTAKE`**

- ユースケースに「事前ヒアリング」(on / off) を持たせる。フォーマットの既定は一問一答 Q&A・壁打ち相談で on、
  雑用・調査レポートで off。作成後はマニュアル画面で切り替えられる。
- 項目: 知りたいこと (必須) / 説明にあたっての技術レベル (必須) / あなたの役職 (必須) / 目的 (任意だが必ず問う)。
  目的は「知ること自体が目的」も正当な答えとして受け付け、聞き返しで責めない。
- 取得:
  - プライベート相談: `/consult` が Discord のモーダル (入力欄 4 つ) を開く。
  - オープン相談: 投稿本文から読み取り、欠けた必須項目と目的を Bot がスレッドで 1 回にまとめて聞き返す
    (モデルの聞き返しと同じ流儀)。必須項目が揃ってから起動する。目的が空のままでも必須が揃えば起動する。
    - 本文の「知りたいこと: / 技術レベル: / 役職: / 目的:」の行を読む。知りたいことの行が無ければ投稿の題名
      (無ければ本文の最初の段落) を知りたいこととみなす。
    - 技術レベル・役職が依頼者メモにあれば聞かずに使い、聞き返しに「この値で答えます。違えば直してください」と添える。
    - 返信は見出し付きで本文へ足す。ラベルの無い返信は、まだ空の項目へ 技術レベル → 役職 → 目的 の順に割り当てる。
      返信では「役職: デザイナー」のほか「役職はデザイナー」の形も項目の指定として読み、1 行に複数並べてもよい
      (「技術レベルは初級 役職はデザイナー」)。返信で指定した値はプロフィールの既定値より優先する。投稿の本文では「〜は」を読まない
      (2026-10-03、この返信が読めず役職がプロフィールのエンジニアのまま起動した)。
    - 返信を 1 度受けたら目的だけのためには再度聞かない。必須が欠ければ同じスレッドで最大 3 回まで聞き返す。
    - 起動の承認カードは廃止した (2026-10-03、[社員名簿 §3](staff-roster.md))。項目が揃ったら投稿者の役職に関わらず起動する。
- 技術レベルと役職は依頼者メモ (`requester_profiles.skill_level` / 新設 `role_title`) に保存し、
  次回のモーダルに既定値として入れる。本人がモーダルで書き換えたら上書きする。
- 4 項目は起動時の対話前提ブロック (dialogue-context.md §5) に「今回の相談」節として入る。

状態所有者: ヒアリング内容 = `consultation_intakes` (dialogue-context)。技術レベル・役職の既定値 = `requester_profiles`。

## 4. プライベート相談

**Requirement ID: `SPEC-CONSULT-PRIVATE`**

- 部署設定に `private` を足す: `enabled` (既定 false) と `approver_min_role` (`manager` | `executive`、既定 `manager`)。
  部署管理画面で編集する。
- 対象は Bot の会社の部署。本社 guild の `/consult` は本社の部署、子会社 guild の `/consult` はその子会社の
  プロジェクトを持たない相談部署だけ (§6)。他社の部署は受けない。
- 流れ:
  1. `/consult start department:<プライベート可の部署>` がモーダル (知りたいこと・技術レベル・役職・目的) を開く。
     技術レベル・役職は依頼者メモの値を既定で入れる。
  2. 送信で「プライベート」カテゴリ (無ければ作る。報告用のプライベートチャンネルと共通 — [プライベートチャンネル](private-channels.md)) にテキストチャンネルを 1 本作る。作成要求に閉じた
     overwrites を含める (CC-CONSULT-INV-01): `@everyone` 不可視、本人・権限者・Bot は可視。
     権限者 = 社員名簿で `approver_min_role` 以上の Discord ユーザー。
     チャンネル名は内容を含めない (`相談-<日付>-<短い id>`)。
     案内の次に、相談内容を 1 通で投稿する (2026-10-13): 部署名・技術レベル・役職・目的 (空なら「未入力」)・
     知りたいこと。モーダルの入力は他に残らないため。チャンネルの中だけに出し、メンションは壊して鳴らさない
     (`allowedMentions.parse = []`)。2000 文字を超える分は知りたいことだけを切り詰め、省略を明示する。
     投稿に失敗しても相談は続ける。
  3. 本人の起動権限 (社員名簿の `session_spawn`) で起動する。2026-10-03 からヒラ社員も起動でき
     ([社員名簿 §3](staff-roster.md))、本人の承認として即座に開く。権限者 (`approver_min_role` 以上) は従来どおり
     閲覧者としてチャンネルに入る。「起動を承認」ボタンは名簿の判定器が起動を断った場合 (未配線など) にだけ残る経路。
  4. 起動は部署セッションと同じ admin spawn (所有会社の検査・部署の起動既定値・ユースケース・事前ヒアリング) を通る。
     モーダルの 4 項目は `consultation_intake` (source `modal`) として渡る。
  5. セッションの面はこのチャンネルそのもの (`session_channels.channel_kind = channel`)。Session フォーラム・
     部署フォーラムにはスレッドを作らない。
- 起動できない (部署がプライベート不可・廃止・本社以外・チャンネル作成失敗) ときはコマンド / モーダルの応答で
  理由を本人にだけ返す。

**Requirement ID: `SPEC-CONSULT-MEMBERS`**

- チャンネル内の `/consult invite user:@x` / `/consult remove user:@x` で閲覧者を追加・除外する。
  操作できるのは本人と権限者だけ (CC-CONSULT-INV-02)。本人と Bot は除外できない。
- 権限者は相談の開始時点の名簿で追加する。名簿が変わっても既存チャンネルの閲覧者は自動では変えない (必要なら invite / remove)。

**Requirement ID: `SPEC-CONSULT-VISIBILITY`**

- 思考・状態カード・セッション情報・コスト報告は、セッションの面 (= このチャンネル) にだけ出る。
- 共有面の確認結果 (2026-09-30): activity は使用量の警告だけ、monitor / pr-queue はチャンネルのメンション
  (見えない人には Discord が名前を伏せる) と金額だけ、連合 (federation) は設定の同期でセッションを運ばない。
  いずれも本文・題名を出さない (CC-CONSULT-INV-03)。
- 面の復旧 (再起動時の reconcile) は、プライベート相談のセッションを Session フォーラムへ作り直さない。
  チャンネルを失ったら復旧せず、相談を閉じたものとして扱う。
- WebUI は運用担当の管理面なので表示する。

**Requirement ID: `SPEC-CONSULT-CLOSE`**

- セッションの終了・消失でチャンネルを書き込み不可 (閲覧は維持) にして残す。削除しない。
- 通常のセッションチャンネルのように archive カテゴリへは移さない (カテゴリの権限に同期すると閉じた権限が外れるため)。

状態所有者: 相談とチャンネル・状態・承認前のヒアリング = `private_consultations`、閲覧者と追加理由 =
`private_consultation_members` (consultation)。

## 5. オープン化の提案と Tabula への公開

**Requirement ID: `SPEC-CONSULT-PUBLISH`**

- 相談の区切りで、相談者本人か権限者が相談チャンネルで `/consult wrap` を使うと、Cc がセッションへ公開候補づくりを依頼する
  (inject)。セッションは会話の文脈を持つので、候補の文面はセッションが作り `POST /v1/consultations/proposals`
  (`session_id` / `title` / `summary`) で出す。受け付けるのは相談中 (open) の相談のセッションだけ。
- 候補は**書き直した要約**で、会話の転載・個人・社内固有・秘密・人の評価に当たる内容を含めない (依頼文で指示する)。
- 候補はチャンネル内に判断カードとして出す: 公開する / 直して公開 (モーダルで編集、4,000 文字まで) / 公開しない /
  取り下げ。**公開・公開しないを決められるのは相談者本人だけ**。権限者は取り下げだけできる (CC-CONSULT-INV-04)。
  権限の判定は Cc の API (`POST /v1/consultations/publications/:id/{publish|decline|withdraw}`、`actor_user_id` は
  Bot が操作者を渡す) が持つ。
- オープン相談 (フォーラム) の公開候補は対象外 (必要になったら拡張する)。

**Requirement ID: `SPEC-CONSULT-TABULA`**

- 公開はメンバー共有 (`visibility: shared`) のページとして Tabula の取り込み API に送り、URL をカードへ返す。
  タグは「技術相談」と部署名。ページ所有者は Tabula の取り込み用所有者のまま。冪等キーは公開候補の id。
- Cc は Tabula の接続先 (`services.tabula_url`) と取り込みトークン (`services.tabula_import_token`) を設定画面 (DB) で持つ。
  トークンは secret-box で暗号化して `schema_meta` に置き、API には実値を返さない。env からは読まない。
  Tabula の秘密は Cc 本体だけが持ち、Bot へは渡さない (公開は Cc の API を通す)。
- 未設定なら公開系のボタンを出さず、理由をカードに添える (無言で押せない状態にしない)。
- 投稿に失敗したら候補を「提案」のまま残し、理由 (`last_error`) を記録して本人に伝える。もう一度押せば再試行できる。
- 公開できたら、相談者へ種類 `tabula` の報奨を個人の AI 予算の口へ依頼する (根拠は公開候補の id、
  [個人の AI 予算](personal-ai-budget.md) §4・§15)。付くかどうか (本社所属は対象外など) は予算側が決め、付かなくても公開は取り消さない。

状態所有者: 候補・判断・投稿結果 = `consultation_publications` (consultation)。

## 6. 子会社の相談窓口 (プロジェクトを持たない相談)

**Requirement ID: `SPEC-CONSULT-PROJECTLESS`**

> 2026-10-01 neco 指示:「GLab 子会社に相談窓口用意」「元々相談課はプロジェクト外のものを受け付ける課。
> private チャンネルを作れるようにして、管理者と本人のみ一旦見れる状態にする」。範囲は「プロジェクト不要」、
> 閉じ込めは推奨案 (相談用ディレクトリ + ツール制限) で承認。

- 価値: [UX-CC-W6](../ux/product.md) / シナリオ UX-CC-S7 を子会社 guild へ広げる。失うと困る利用者の状態: 子会社の
  メンバーが技術の質問をしたくても、関係プロジェクトに紐づかない質問は窓口に投稿しても起動されず、聞く場所が無い。
- 子会社のセッションは関係プロジェクトで起動範囲を閉じる (subsidiary-delegation §3.4)。その例外として、
  **担当プロジェクトを持たず、ユースケースが読み取り専用の部署** (技術相談課) はプロジェクト無しで起動する (CC-CONSULT-INV-06)。
  - 部署フォーラム: 本文からプロジェクトを拾わず、関係プロジェクトの照合もしない (`ForumSpawnDepartment.projectless`)。
  - `/consult`: 子会社 guild に登録する。部署の候補はその子会社の、プライベート相談を許可した相談部署だけ。
- 作業ディレクトリ (2026-10-02 neco 指示「相談は役職ごとにディレクトリを分けてスキルやメモリを使い分ける。Castra のメモリや
  ワークフローは引き継がない。相談で使用する環境のメモリは別途指定する。作業ディレクトリは E:/Document/Consult/役職ごとのフォルダとし、
  データを Discord の個人 ID のフォルダを作って保存する」):
  読み取り専用で担当プロジェクトを持たない部署は、本社・子会社とも役職ごとの作業ディレクトリで起動する。
  - 置き場所は `CONCORDIA_CONSULT_WORKSPACE_ROOT`、既定は `E:/Document/Consult` (Concordia の 2 つ上の `Consult`)。
    Castra (E:/Document/Ars) の外に置き、Castra の CLAUDE.md・スキル・hook を引き継がない。
  - 役職フォルダは事前ヒアリングの役職から `engineer` / `planner` / `designer` / `sound` / `general` (読めない・未記入) に
    読む (`src/consultation/consult-role.ts`)。モデル選び (下記) も同じ区分を使う。本社・子会社では分けない。
  - 役職フォルダ自身の指示とスキルは役職ごとの使い分けのために読ませる。中身は人が置く。
    相談で使う環境のメモリは別途指定する (自動メモリは使わない)。
  - **指示とスキルは Claude と codex で共通にする** (2026-10-03 neco 指示「Claude も AGENT.md を見るようになったはずなので
    いまは設定を共通化できるはず」)。
    - 指示は役職フォルダの `AGENTS.md` 1 本。Claude Code (v2.1.277 以降) は作業フォルダとその上に CLAUDE.md が無ければ
      AGENTS.md を指示として読み、codex も cwd の AGENTS.md を読む。上位フォルダの CLAUDE.md / AGENTS.md は今どおり
      `claudeMdExcludes` (claude) と `project_root_markers = []` (codex。上位を探さない) で外す。
    - スキルの正本は役職フォルダの `.agents/skills` (codex が cwd から探す場所。Claude は `.agents/` を読まない)。Cc はフォルダの
      準備のたびに、`.claude/skills` が無ければ `.agents/skills` への junction を張る (張れなければコピー。
      `src/consultation/consult-role-skills.ts`)。既にある `.claude/skills` は触らない。
    - **移行の案内 (自動では移さない)**: 既存の役職フォルダに `CLAUDE.md` や `.claude/skills` があれば、人が `CLAUDE.md` を
      `AGENTS.md` へ、`.claude/skills/*` を `.agents/skills/*` へ移し、古い `CLAUDE.md` と `.claude/skills` を消す
      (消すと次の起動で junction が張られる)。CLAUDE.md が残っていると Claude はそちらを読み AGENTS.md を読まない。
      移すまでの間は、codex の相談に CLAUDE.md と `.claude/skills` を初回指示で載せ (下記)、warn ログに移す案内を出す。
  - 相談者のデータは役職フォルダの下に Discord の個人 ID のフォルダ (`<役職>/<Discord ID>/`) を作って保存する。場所は起動 env
    `CONCORDIA_CONSULT_DATA_DIR` で渡す。Discord 以外からの起動 (ID が無い) では作らない。
  - 本社: 起動要求がプロジェクト・cwd・チーム等を指定していなければここで起動する (指定があればそれに従う)。
    ツールの制限と設定フォルダは子会社と同じ (2026-10-02 neco 指示「本社の相談も同じで」)。プロジェクト無しでは cwd を決められず起動に失敗していた (`project cwd is required`) のを直す。
- モデル (2026-10-19 neco 指示「Consultの起動をすべてAstraにしてほしい」): 本社・子会社とも、相談部署の標準起動は
  全役職・役職未入力で Astra (`astra-mid`、codex) に統一する。effort は medium。2026-10-02 の役職別選択を置き換える。
  テンプレート名は `CONCORDIA_CONSULT_ASTRA_TEMPLATE` で差し替えられる。既存のテンプレート・provider・モデルの明示指定は維持する。
  部署フォーラムからの相談でもモデルを聞き返さない。モデル選択方針の所有者は consultation
  (`src/consultation/consult-model.ts`)、価値は UX-CC-W6 / UX-CC-S7。役職によって標準モデルが変わらないことを不変条件とし、
  相談の隔離権限 (CC-CONSULT-INV-07) と役職の前提注入 (CC-CONSULT-INV-11) を維持する。
- 重複した相談の近道 (2026-10-02 neco 指示「相談セッションの内容は重複があればセッションや Tabula を案内し、その内容のキャッシュ
  された回答を返却する」「重複の場合もセッションは起動して回答をショートカットするだけ」): 相談部署の起動では、公開済みの相談
  (`consultation_publications` の published、新しい順に 500 件) から、事前ヒアリングの話題と依頼本文に似たものを文字の 2 文字組の
  一致度 (Dice 係数 0.3 以上、上位 3 件) で選び、初回指示に「過去の公開回答」として記事のリンク・要約・公開済みの回答を添える。
  セッションは必ず起動し、重複かどうかの最終判断はモデルに任せる (同じなら公開済みの回答を要約して記事を案内し、足りない点だけ
  答える)。回答は FINAL ANSWER として出る。非公開の相談の回答は他の人に返さないため、候補は公開済みのものに限る
  (`src/consultation/duplicate-consultation.ts`)。
- 閉じ込め (CC-CONSULT-INV-07、本社・子会社とも)。Castra のハーネスフックは Castra 配下の一部ツールにしか掛からないため、
  起動する claude 本体で閉じる:
  - cwd は役職フォルダ。
  - claude の引数 `--tools=WebSearch,TodoWrite,Skill,Bash --strict-mcp-config`。Read・編集・利用者の MCP を持たない。
    シェルは役職フォルダの `.claude/settings.local.json` の `permissions` (`defaultMode: "dontAsk"`、allow は WebSearch / TodoWrite /
    Skill / `Bash(node <置き場所>/_source/tools/fetch-link/fetch-link.mjs:*)`) で公開リンクの取得コマンドだけを許し、ほかは聞かずに拒否する
    (`consultClaudePermissions`、下記「公開リンクの取得」)。
  - claude は相談専用の設定フォルダ (`<置き場所>/.claude-config`) を `CLAUDE_CONFIG_DIR` にして起動する。利用者の ~/.claude
    (Castra のワークフローを含むスキル・CLAUDE.md・設定) を読まず、スキルは役職フォルダ (`<役職>/.claude/skills`) のものだけを使う
    (2026-10-02 neco 選択「設定を分けて使えるようにする」)。役職フォルダの信頼はその設定フォルダの `.claude.json` に Cc が書く
    (Lictor の事前焼き込みは ~/.claude.json にしか書かないため)。ログイン情報もその設定フォルダに持つ。未ログインなら claude の
    相談は 503 `projectless_consult_claude_login_required` (初回は人が `CLAUDE_CONFIG_DIR=<設定フォルダ> claude` でログインする)。
    Lictor のフック (ハーネスのゲート) は `--settings` で渡るので、設定フォルダを分けても効く。
    transcript も設定フォルダの `projects` に書かれるので、Cc は起動時にそこを Claude Code のログ親として登録し
    (`setExtraClaudeProjectRoots`)、予算・コスト報告・ログ集計で相談の消費を数える (2026-10-03 修正、それまでは 0 だった)。
  - 公開リンクの取得 (2026-10-03 neco 指示「相談時にもらった Notion のオープンなリンク / Google Drive を取得できるようにする」、
    方式は neco 選択「相談セッション側で実行 + Drive は公開リンクのみ」)。取得スクリプトの正本は相談フォルダのリポ
    (`<置き場所>/_source/tools/fetch-link/fetch-link.mjs`、スキル `consult-fetch-link`)。公開 Notion は `www.notion.so/api/v3/loadPageChunk`
    (届かないときだけ Canalis の notion-public を写した描画)、Google Drive は「リンクを知っている全員」のものを認証なしで読む。
    https の決まったホスト以外 (ファイルのパス・社内のアドレス) は受けない。Cc は場所と許可だけを持つ (`src/consultation/consult-fetch-link.ts`):
    - 起動 env `CONCORDIA_CONSULT_FETCH_LINK_SCRIPT` にスクリプトの絶対パスを渡す。
    - codex (Astra) は相談の CODEX_HOME の config.toml に PreToolUse フックの信頼 (trusted_hash) が記録されているときだけ
      `--disable shell_tool` を外す (`readConsultCodexPreToolHookTrusted`、`confinementArgsFor(..., { codexShell })`)。シェルの制限は
      フック (`tools/consult-codex-hook.mjs` → `tools/consult-fetch-link-command.mjs`) が担い、取得コマンドの形以外は Cc に聞かずに止める
      (Cc に届かなくても止める)。フックが未信頼ならシェルは外したまま。hooks.json の定義を変えると信頼がやり直しになるので、変えるときは
      この判定も見直す。
    - Cc の相談の情報保護境界 (`src/consultation/safety-policy.ts` の `consultationToolAllowed`、ハーネスの gate から呼ばれる) でも、
      シェル系ツール (Bash / shell / exec_command など) は `node <…>/_source/tools/fetch-link/fetch-link.mjs <url>` の形だけを通す
      (`isConsultFetchLinkCommand`)。`;` `&` `|` `` ` `` `$` `<` `>` 改行を含むものは通さない。どの相談フォルダかの厳密な一致は前段の
      権限 (claude) とフック (codex) が持つ。通した後も内容の分類 (個人情報・機密) は従来どおり行う。2026-10-06 neco 指示「Notion の
      公開リンクの取得が、相談ハーネスでブロックされる」: この境界が Bash を一律に unsafe_tool で止めていた。
  - ツール制限を外す部署 (部署設定 `consult_tools: "all"`、既定 `restricted`。2026-10-06 neco 指示「Consult のハーネスを
    すべて許可する設定」、選択「ツール制限だけ外す」):
    - claude: 起動引数の `--tools=` を外す (`PROJECTLESS_CONSULT_CLAUDE_ARGS_ALL_TOOLS`)。役職フォルダの permissions は
      `defaultMode: "dontAsk"` のまま組み込みツール (Bash・Read・Write・Edit・WebFetch など、`CONSULT_ALL_TOOL_NAMES`) を
      名前で許す (`consultClaudePermissions(..., { allTools })`)。名前だけの規則はそのツールのどの使い方も許す。
      最初は `defaultMode: "bypassPermissions"` にしたが、claude 側で一度だけの承認を求めることがあり、Lictor 経由の起動では
      承認できず don't ask で Bash が拒否された (2026-10-06)。
    - codex: シェルを残し、sandbox を `workspace-write` にする (`confinementArgsFor(..., { allTools })`)。起動 env
      `CONCORDIA_CONSULT_ALL_TOOLS=1` で、フック (`tools/consult-codex-hook.mjs`) はシェルを止めない。
    - Cc の情報保護境界: ツールの判定を飛ばす (`toolsUnrestricted`)。
    - 残すもの: 個人情報・機密の内容判定 (秘匿語辞書・分類器)、利用者の MCP を読ませない (`--strict-mcp-config` /
      `mcp_servers={}`)、プラグイン無効、自動メモリ無効、上位フォルダの指示ファイルを読ませない (`claudeMdExcludes` /
      `project_root_markers=[]`)、作業ディレクトリを役職フォルダに固定。
    - 予算切れからの再開 (`src/control/budget-resume-launch.ts`) は制限付きの引数のまま (安全側。未対応)。
    - 役職フォルダの settings.local.json は起動のたびに書き直すので、同じ役職を制限あり・なしの部署で共有すると、後に
      起動した部署の設定になる。
    - 未確認 (2026-10-03): codex の `-s read-only` の sandbox で取得スクリプトのネットワーク通信が通るか。通らなければ Astra の取得は
      「取得中にエラー」になる (閉じ込めは変わらない)。
  - ブランチ切替の案内 (`src/testing/branch-watch.ts` の「⚠️ ブランチ切替を検知しました」) は相談のセッションに出さない
    (2026-10-03 neco 指示「相談窓口へのブランチ切り替えは通知しないでください」)。相談はコードを書かず、案内は相談者に届く。
    判定は作業ディレクトリが置き場所の中か (`isInConsultWorkspace`、`startBranchWatch` の `isExempt`)。
  - codex (Astra) の引数 `-s read-only --disable shell_tool --disable plugins -c project_root_markers=[] -c mcp_servers={}`
    (フックが信頼済みなら `--disable shell_tool` を外す。上記)。
    codex の読み取り専用 sandbox は Windows でファイルの読み取りを止めない (2026-10-02 実測) ため、読む手段のシェルそのものを外し、
    プラグイン・MCP も読ませない。指示は役職フォルダ (cwd) の AGENTS.md だけを読ませる (上位フォルダは探さない。2026-10-03 に
    `project_doc_max_bytes=0` を外した)。画像を読む view_image はパスを指定すれば画像を読める余地が残る。
  - codex (Astra) は相談専用の CODEX_HOME (`<置き場所>/.codex-home`、`consultCodexHome`) を起動 env `CODEX_HOME` にして起動する
    (2026-10-03 neco 指示「(Astra の相談の個人設定の分離と途中停止) これは codex のも作ってほしい」)。
    利用者の ~/.codex (AGENTS.md・スキル・フック・MCP・設定) を読ませない。`src/consultation/consult-codex-home.ts`。
    - ログイン情報 (`auth.json`) はその CODEX_HOME に持つ。未ログインなら codex の相談は 503
      `projectless_consult_codex_login_required` (claude の login_required と同じ扱い)。
    - Cc は起動のたびに CODEX_HOME の `hooks.json` と `consult.config.toml` を書き直す (ログイン前でも書く)。codex は
      `-p consult` で起動し、`consult.config.toml` を基本の `config.toml` に重ねる。`config.toml` は codex が書く (フックの信頼
      `[hooks.state]`・フォルダの信頼 `[projects]`) ので Cc は触らない。2026-10-03 まで Cc が `config.toml` を起動ごとに
      書き直しており、フックを信頼しても次の起動で記録が消えていた。
      - `hooks.json`: PreToolUse → Cc のハーネス判定 (`POST /v1/harness/gate`。予算切れの `usage-budget` を含む deny を
        `hookSpecificOutput.permissionDecision: "deny"` で返す)、SessionStart → transcript_path を Cc のセッションへ報告
        (`PATCH /v1/sessions/:id`)。相談は MCP を外すので、MCP を使わない command 型で `tools/consult-codex-hook.mjs` を呼ぶ。
        Cc のセッション id は起動 env の `CONCORDIA_SESSION_ID`。Cc に届かない・判定に失敗したときはツールを止めない。
      - `consult.config.toml`: `project_root_markers = []` と、利用者のスキル (`$HOME/.agents/skills/*/SKILL.md`。CODEX_HOME を分けても
        codex が読む) をすべて `[[skills.config]] enabled = false` にする。
    - transcript は CODEX_HOME の `sessions` に書かれるので、Cc は起動時にそこを codex のログ親として登録し
      (`setExtraCodexSessionRoots`)、予算・コスト報告・ログ集計で数える。
    - **人がやること (初回 1 回)**: PowerShell で `$env:CODEX_HOME = "<置き場所>\.codex-home"; codex login` でログインし、
      続けて同じ CODEX_HOME で `codex` を起動して `/hooks` から Cc が書いた 2 つのフック (PreToolUse / SessionStart) を
      信頼する。codex は新しい・変わったフックを信頼されるまで実行しない (信頼はフック定義のハッシュに対して記録され、
      Cc は毎回同じ内容を書くので 1 回でよい。Concordia の配置場所が変わるとコマンドが変わるので信頼し直す)。
  - 指示ファイルを読めない provider では、役職フォルダの指示のうち読めない分を Cc が初回指示に載せる (CC-CONSULT-INV-11、
    2026-10-02 neco 指示「役職は spawn 前に決定するので読み分けで良い」)。2026-10-02 までは Astra (codex) が役職フォルダの
    指示もスキルも読めず、デザイナー・サウンドの相談者だけ役職ごとの回答の作り方 (技術レベルに合わせる・非公開の内容を
    検索語に入れない・できない依頼の断り方など) が効かない回答を受け取っていた。
    - 2026-10-03 から codex は役職フォルダの AGENTS.md を自分で読むので、AGENTS.md は載せない (二重に読ませない)。
      スキルは、相談の codex がシェルを持たず SKILL.md を開けないため、本文を載せ続ける。移行前の CLAUDE.md
      (AGENTS.md が無いとき) は codex が読めないので載せる。
    - 対象は相談の作業ディレクトリで起動し、解決後の provider が claude 以外のとき (`needsInlineRoleGuidance`)。claude は自分で
      読むので載せない (二重になる)。テンプレート経路・provider 直指定の経路とも、provider の解決後に組む。
    - 読むのは役職フォルダ直下の `CLAUDE.md` (AGENTS.md が無いときだけ) と、スキル (`.agents/skills/<名前>/SKILL.md`。
      `.agents/skills` が無ければ移行前の `.claude/skills/<名前>/SKILL.md`) だけ。相談者のデータフォルダや上位のフォルダは読まない
      (CC-CONSULT-INV-08 と同じ範囲)。無い・読めないファイルはその分を載せずに起動を続け、読めなかったものは warn ログに名前だけ出す。
    - 置き場所は「作業範囲の制限」の直後、対話の前提データの前。見出し `## 相談窓口の前提と手順` に続けて「このセッションではスキルを
      呼び出せません。『〜を読んでください』とある手順は、下に全文を載せています」の 1 行、CLAUDE.md の本文、スキルごとの
      `### 手順: <スキル名>` と本文 (frontmatter を外す、名前順) を並べる。
    - 全体の上限は 40,000 文字。超えるときはスキル単位で後ろから載せるのをやめ、途中で切った本文は載せない。載せなかったスキル名は
      warn ログに出す (本文はログに出さない)。
    - 状態を持たない。問題が出たら admin spawn の配線を外せば従来の初回指示に戻る。
  - それ以外の provider は 400 `projectless_consult_requires_confinable_provider`。
  - 起動要求に project / cwd / team / branch / worktree / 利用者の args / テンプレの prompt 注入があれば 400
    `projectless_consult_scope_fixed`。置き場所が未設定なら 503。
- 閲覧者: 社員名簿は本社と子会社で共通で会社の所属を持たないので、本社・子会社とも名簿の権限者のうちその guild に在籍する人だけを閉じたチャンネルに入れる ([社員名簿 §9](staff-roster.md))
  (居ない人の member overwrite はチャンネル作成ごと失敗させる)。在籍の確認に失敗したら受け付けない。
  名簿の外の人を足すことはできない。
- 子会社では公開候補 (`/consult wrap` と判断カード) を出さない。公開は本社の知見共有の面で、相談セッションはシェルも持たない。
- 上位の CLAUDE.md と自動メモリは読ませない (CC-CONSULT-INV-08)。2026-10-02、相談用ディレクトリを Concordia 配下に移した
  直後に、Castra の CLAUDE.md (略称表) と Concordia の自動メモリが相談セッションに読み込まれ、回答に社内のプロジェクト名が
  出た。役職フォルダを用意するたびに `.claude/settings.local.json` を書き、上位のフォルダと相談者のデータフォルダの中の
  CLAUDE.md / CLAUDE.local.md / AGENTS.md / `.claude/rules` を `claudeMdExcludes` で外す。起動 env でも自動メモリを止める。
- 閲覧者は執行役員 (権限者の最低役職を executive に設定) で、案内文には列挙もメンションもしない (2026-10-02 neco 指示)。
- 起動時の注入は初期だけ (部署設定 `startup_inject: initial-only`、departments.md §9.5)、出力は最終回答だけ
  (状態カード以外の `output.*` をすべて off、departments.md §9.4)。前提質問と状態カードは残る。
  **相談は FINAL ANSWER 以外を投稿しない** (CC-CONSULT-INV-10)。chat 経路の投稿・セッション情報カード・コスト報告・
  終了時の `/session-end` 自動指示と #報告 への独白も出さない (2026-10-02 neco 指示)。
- 説明の仕方は技術レベルに合わせる (初級: 小学五年生でわかるように専門用語なし / 中級: 専門用語可、シニアの話は噛み砕く /
  上級: シニアとして扱う。`src/dialogue/skill-level.ts`)。
- 残る露出: 起動時の共通資料案内 (Castra のパス名) はセッションに渡る (初期だけの部署では送らない)。

状態所有者: 作業ディレクトリの場所 = 起動設定 (admin spawn)。相談専用の CODEX_HOME の中身 (フック・設定) = consultation
(`src/consultation/consult-codex-home.ts`、フック本体 `tools/consult-codex-hook.mjs`)。役職フォルダのスキルのつなぎ =
consultation (`src/consultation/consult-role-skills.ts`)。役職の区分 = consultation (`src/consultation/consult-role.ts`)。判定 = consultation (`src/consultation/projectless-consult.ts`)。役職の指示を初回指示に載せるか・その組み立て = consultation (`src/consultation/role-guidance.ts`)、読み込み = `src/consultation/role-guidance-files.ts`。

### 6.1 「終了」で相談を終える

> 2026-10-03 neco 指示:「『終了』でセッション終了します」→ 補足「これは相談窓口で終了と言われたら終了するという意味です」。

- 相談の部署 (`isProjectlessConsultDepartment`、本社・子会社とも) のセッションに限り、人の発言全体が
  「終了」「終了です」「終了します」「終わり」「おわり」「終わりです」(末尾の「。.!！」可、空白は無視) なら終了の指示として扱う
  (`detectsConsultEndWord`、`src/consultation/consult-end-word.ts`)。既存の「セッション終了」「session-end」等はそのまま。
- 打ち消し (「終了しないで」) や文中の「終了」(「終了条件を教えて」「これで終わりですか」) は対象外。
- 相談以外のセッションでは一言の「終了」を拾わない (誤って終わらせる損害の方が大きい)。
- 相談では、終了の権限 (`session_end`) を持つ人に加えて、**その相談を起動した相談者本人** (session metadata の
  `discord_requester_user_id`) も自分の相談を終えられる。相談者は一般の社員であることが多く、権限者だけに限ると
  相談窓口で「終了」と言っても終わらないため (2026-10-03 実装時の判断。他人の相談は終えられない)。
- 終了の流れは既存のまま (印 `session_end_requested_at` → 静かになってから `endSessionNow`、§7 の後始末・共有の確認)。
  判定の配線は Discord の受付 (`src/discord/ingress.ts`、`isConsultSession` は Bot がセッションの部署から判定)。

### 6.2 相談ログ

**Requirement ID: `SPEC-CONSULT-LOG`**

> 2026-10-03 neco 指示:「相談内容は Consult フォルダにすべてログとして保存するようにしてください」「時刻は JST」。

- 場所: 相談のセッションごとに、相談者のデータフォルダの `logs/` に Markdown を 1 本書く。
  `<役職フォルダ>/<Discord ID>/logs/<YYYY-MM-DD>_<session id>.md` (日付はセッション開始の JST)。Discord 以外の起動
  (相談者の ID が無い) は `<役職フォルダ>/_unknown/logs/`。役職フォルダはセッションの作業フォルダで、相談の置き場所
  (`CONCORDIA_CONSULT_WORKSPACE_ROOT`) の外にあるセッションには書かない (プロジェクトのリポへ書かない)。
- 中身:
  - 見出し: 開始時刻 (JST)・部署・役職 (役職フォルダ)・モデル・セッション id。
  - 事前ヒアリング: 知りたいこと・技術レベル・役職・目的 (§3。受付チャンネルの最新の `consultation_intakes`。無ければ「記録なし」)。
  - やり取り: 「相談者の発言」(Discord / Slack / Web から入った人の発言) と「最終回答 (FINAL ANSWER)」(最終回答・会話の要約) を
    時刻 (JST) つきで時系列に追記する。同じ発言は 1 回だけ (編集で届き直しても書き足さない)。
  - 終了: 終了時刻 (JST) と終了理由 (発言による終了の指示 / セッションの終了 / セッションの消失)。
- 書かないもの: Cc の指令 (inject の転記: task / delegation / system)・途中の発言・思考・ツール出力・端末からの入力。
  投稿と同じ範囲 (CC-CONSULT-INV-10)。
- 書く時: 発言ごとに追記する (Cc が落ちても途中まで残る)。最初の 1 件の前に見出しと事前ヒアリングを書き、
  `session.ended` / `session.lost` で終了を書く。セッションごとに順に書く。
- 失敗: 書き込みの失敗は warn ログだけで相談は止めない。warn にログ本文は出さない。
- 置き場所はデータフォルダの中なので、CC-CONSULT-INV-08 の `claudeMdExcludes` の対象で、相談セッションに指示として読まれない。
  CC-CONSULT-INV-05 の「ログ」は Cc のサービスログ (連合・通知を含む) のことで、相談者のデータフォルダへの相談ログは
  neco 指示による保存先として別に扱う。
- 状態を持たない (書き済みの発言 id はメモリだけ)。問題が出たら `src/bootstrap/core.ts` の購読を外せば書かなくなる。

状態所有者: 相談ログの場所と中身 = consultation (`src/consultation/consult-log-markdown.ts`)、追記と購読 =
`src/consultation/consult-log-writer.ts` (配線 `src/bootstrap/core.ts`)。一言の「終了」の判定 = `src/consultation/consult-end-word.ts`。

### 6.3 相談用 Claude のログイン切れの検出

2026-10-03〜04、相談専用の Claude 設定フォルダ (`<置き場所>/.claude-config`) の認証が通っておらず (OAuth Error 400)、相談の claude は
起動直後のログイン画面で止まった。Cc 上はセッションが active のまま transcript が作られず、相談者には何も返らなかった。
それまでの起動前の判定は `.credentials.json` の有無だけだった (neco 指示「再発防止入れて」)。

- 起動前 (`consultClaudeLoginState`、`src/consultation/consult-claude-login.ts`): `.credentials.json` が無い・壊れている・更新用トークンが
  無い・更新用トークンの期限 (`refreshTokenExpiresAt`) 切れなら、従来どおり 503 `projectless_consult_claude_login_required`。
  アクセストークンの期限切れは claude が更新するので止めない。トークンの値は読まず、有無と期限だけを見る。
- 起動後 (`startConsultStartupWatch`、`src/consultation/consult-startup-watch.ts`、配線 `src/bootstrap/core.ts` の key `test`):
  更新用トークンが無効にされた場合はファイルからは分からないので、相談用ディレクトリで起動した claude が起動から
  `CONSULT_STARTUP_GRACE_SEC` (180 秒) たっても transcript を持たなければ、Cc の system チャンネルへ 1 度だけ知らせる。
  本文はセッション id と場所、再ログインのコマンド (`consultClaudeReloginCommand`) だけで、相談の内容は含めない。
  codex (Astra) は transcript を SessionStart フックで報告する別経路なので対象外。

### 6.4 モデル・サウンドのファイル受け渡し (Google Drive)

**Requirement ID: `SPEC-CONSULT-DRIVE-TRANSFER`**

> 2026-10-01〜02 neco 指示 (Pf フラグメント 01M3XVA8BKK0JEYDSGFP1E9DM6):「Ccの相談で『モデルを見て欲しい』『サウンドを見て欲しい』を
> する時、セキュアなデータ送信領域を作成してSynergosを使って送受信する。通信できない場合はGoogle Driveを使う。修正した内容を画像で
> 可視化できる場合はサマリー画像を用意してDiscordで転送する。」 2026-10-14 neco 判断:「いったん Google Drive でいい」。
> 同日 neco 指示:「GoogleDriveは使用するユーザに編集可能な共有設定をかけてもらう感じです。」 (Cc がフォルダを作る形から、
> 相談者が自分のフォルダを Cc のサービスアカウントへ編集者で共有する形へ変えた)

- 価値: デザイナー・サウンドの相談者が、Discord の添付の上限や公開リンクに頼らずに 3D モデル・音声を相談へ渡し、
  直したファイルを受け取れる。失うと困る利用者の状態: 相談者が見てほしいファイルを渡す手段が「リンクを知っている全員」の
  公開リンクしかなく、相談のためにファイルを公開しないといけない。
- Pf フラグメントの要件との対応:

  | 要件 | 状態 |
  |---|---|
  | セキュアなデータ送信領域を作る | 相談者が自分の Drive に用意し、Cc のサービスアカウントにだけ編集者で共有したフォルダを相談 1 件に結び付ける (下記) |
  | Synergos で送受信する | **作らない。当面は Google Drive のみ (2026-10-14 neco)** |
  | 通信できない場合は Google Drive | Google Drive を唯一の経路にする |
  | 修正内容のサマリー画像を Discord で転送 | **未実装・今後** (この節の対象外) |

- 対象: プライベート相談 (§4) で、セッションが相談の置き場所 (§6 の役職フォルダ) で動く相談だけ。相談者のデータフォルダ
  (`<役職>/<Discord ID>/`) をセッションの作業フォルダ (`sessions.repo_path`) と相談者の Discord ID から求め、求まらない相談
  (プロジェクトの作業領域で動く相談・未起動) は「この相談ではファイル受け渡しを使えません」と返す。部署フォーラムの相談は対象外。
- 使い方 (相談チャンネルの中):
  - `/consult files` (相談者本人だけ): 未設定なら「ファイル受け渡しは未設定」をチャンネルに出す。設定済みなら、相談者だけに見える
    返信で、共有する相手 (Cc のサービスアカウントのメールアドレス) と手順 (自分の Drive にフォルダを作る → そのアドレスを
    **編集者** で共有する → `/consult files folder:<URL>` を実行する) を返す。Cc はフォルダを作らず、相談者のメールアドレスも聞かない。
  - `/consult files folder:<URL か ID>` (相談者本人だけ): 相談者が共有したフォルダを相談に結び付けて、フォルダのリンクを
    チャンネルへ出す。受け付けるのはフォルダ ID と `https://drive.google.com` のフォルダの URL (`/drive/folders/<id>`、
    `/drive/u/<n>/folders/<id>`、`/open?id=<id>`) だけ。結び付ける前に、サービスアカウントからそのフォルダに届くかを確かめ、
    次のときは理由を返して結び付けない: 届かない (共有されていない・無い)、フォルダでない・ゴミ箱にある、閲覧者 (コメント可を含む)
    としてしか共有されていない (Drive の `capabilities.canAddChildren` が false)、他の相談者の相談に結び付いている。
    同じ相談に前に結び付けたフォルダがあれば、そちらの印を外して付け替える (フォルダ自体は消さない)。
  - `/consult files-sync` (相談者本人と権限者): 双方向に同期して結果をチャンネルへ出す。
    - 結び付いたフォルダが無ければ「まだ受け渡しフォルダが結び付いていません」と返す (相談者が共有を外したときも同じ)。
    - 受け取り: フォルダ直下の相談者のファイルのうち、3D モデル (`.fbx .obj .glb .gltf .blend .vrm .stl .dae .3ds .usdz .usd .ply .abc .max .ma .mb`)
      と音声 (`.wav .mp3 .ogg .flac .aif .aiff .m4a .opus`) で 200 MB 以下のものを、データフォルダの `transfer/incoming/` へ取り込む。
      名前はファイル名部分だけを使い、パスの文字を落とす。同じ名前があれば上書きしない (Drive 側に取り込み済みの印を付け、2 回目は取らない)。
      対象外の種類・大きすぎるもの・名前が使えないものは取らずに理由を返す。取り込んだらセッションが動いていれば場所を inject で伝える。
    - 回答: データフォルダの `transfer/outgoing/` にあるファイル (同じ種類・大きさの制限) を同じ Drive フォルダへ置き、
      チャンネルで相談者に知らせる (メンション)。Drive 側に回答の印 (`ccKind=answer`) と元の名前を付け、同じ名前は 2 回置かない。
      回答のファイルは受け取りの対象にしない。
- 認証情報: Google Drive のサービスアカウントの鍵 (JSON) を `services.google_drive_service_account` として Cc の設定画面 (DB)
  で持つ。鍵は既存の秘密 (Tabula の取り込みトークン、§5) と同じ 1 系統で、secret-box で暗号化して `schema_meta` に置き、API には
  実値を返さない。env からは読まない。秘密は Cc 本体だけが持ち、Bot へは渡さない (Bot は Cc の API
  `POST /v1/consultations/:id/drive/{guide|link|sync}` を呼ぶ)。相談者に案内するのは鍵の中の `client_email` だけ。
  - 方式はサービスアカウント: Cc に既存の Google 連携 (OAuth のクライアント・トークン) が無いため (2026-10-14 実装時の判断)。
    フォルダは相談者の Drive にあり、容量も相談者の持ち分を使うので、サービスアカウント側に親フォルダ・共有ドライブは要らない
    (旧 `services.google_drive_parent_folder_id` は廃止)。
  - 回答の置き方の制約 (未確認・判断が要る): 相談者のマイドライブのフォルダにサービスアカウントが置いたファイルは、持ち主が
    サービスアカウントになり、その容量に数えられる。Google はサービスアカウントに保存容量を持たせない方針のため、回答の
    アップロードが容量不足で断られうる (受け取りは相談者のファイルを読むだけなので影響しない)。相談者のフォルダが共有ドライブに
    あれば持ち主は共有ドライブになり問題ない。断られたときは `drive_failed` を返し、相談は止めない。
  - fail closed: 鍵が未設定・読めない・復号できないときは受け渡しを使わず、相談チャンネルで「ファイル受け渡しは未設定」と伝えて、
    相談は従来どおり続ける。Drive の呼び出しに失敗したときも理由を返すだけで相談は止めない。例外にアクセストークン・鍵・
    Drive の応答本文を載せない。
- 状態は Drive が持つ: 相談とフォルダの結び付きは、相談者のフォルダに付けるアプリのプロパティ `ccConsultationId=<相談 id>`
  (アプリのプロパティは Cc のサービスアカウントの Google Cloud プロジェクトからしか見えない) で持ち、同期のたびにこの印で
  探す。取り込み済み (`ccImported=1`)・回答 (`ccKind=answer`、`ccSourceName`) もファイルのプロパティに持つ。Cc の DB は増やさない
  (migration なし)。保存する個人情報はフォルダ ID (の印) だけで、相談者のメールアドレスは受け取りも保存もしない。
  フォルダ名は相談者が決める。
- 閉じ込めとの関係 (CC-CONSULT-INV-07 は変えない): 取り込み先はデータフォルダの中なので相談セッションの作業フォルダの下にあるが、
  ツール制限のある相談 (`consult_tools: restricted`) は Read もシェルも持たないため、ファイルを開けない。ファイルを読み書きできるのは
  ツール制限を外した部署 (`consult_tools: all`) の相談だけ。制限のある相談に相談者ごとの読み取りを許すかは判断が要る (未対応)。
- 後始末 (§7): フォルダは相談者のものなので、**Cc は消さない**。共有もそのまま残る (共有を外す権限は持ち主の相談者にあり、
  Cc は自分の共有を外す呼び出しを持たない)。相談者に案内する手順で「不要になったら共有を外すか削除してください」と伝える。
  相談の後始末で Cc が自分のアクセスを外すか (サービスアカウントは編集者なので自分の権限は外せる) は判断が要る (未対応)。
- 未実装・今後: 修正内容のサマリー画像 (Discord への転送)、Synergos の経路、制限のある相談からの読み取り、後始末で共有を外すこと。

状態所有者: 受け渡しの判断 (種類・大きさ・名前・フォルダの参照の読み方・結び付けてよいか・設定) = `src/consultation/drive-transfer-policy.ts` /
`drive-transfer-config.ts`、手順 = `drive-transfer-service.ts`、Drive の REST = `google-drive-client.ts` (ポート
`drive-transfer-port.ts`、認証 `google-service-account-token.ts`)、API = `src/api/consultation-drive.ts`、
Discord のコマンド = `src/discord/consult-drive.ts`。

### 6.5 社内資料の地図 (Notion 記事マップ) の共有

neco 指示 (2026-10-18)「クロール終わってマップとまとめを作ったら Consult にも共有」。巡回チャットの知識の Notion 記事マップ
(spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」) を、本社の相談セッションが引けるようにする。

- 手段: 相談の開始時の文脈 (作業範囲の説明 `projectlessConsultRestriction()` の直後) に、マップの概観・起点ごとのまとめ・ページの一覧を
  読み取り専用の資料として添える。相談に許すコマンドは増やさない (取得コマンドは公開リンクの `consult-fetch-link` 1 本のまま、
  CC-CONSULT-INV-07)。相談の安全判定 (`safety-policy.ts` / `consultation-harness.mjs`) も変えない。
  スキルに取得コマンドを足す案は、相談フォルダのリポにスクリプトを置く必要があり Cc だけで閉じないため採らなかった。
- 渡すもの: 題名・パス・要約・キーワード・まとめ・ページ URL まで (`buildConsultNotionMapContext`、16 KB まで。越えたら後ろのページから
  省いて省いた件数を書く)。本文の断片は渡さない。除外したページ (個人ページ・チーム・タスクリスト等) はマップに保存しないので出ない。
- 公開範囲: 記事マップは hq。本社の相談 (`subsidiaryId=null`) だけに添え、子会社の相談では呼ばない (`resolveProjectlessConsultLaunch`)。
  CC-CONSULT-INV-08 (社内のプロジェクト名を回答に持ち込まない) の例外として、本社の相談にだけ neco の指示で社内資料の目次を渡す。
- 失敗時: マップが空・読めないときは添えずに相談を始める。
- 状態所有者: 文脈の組み立て = `src/rules/notion-map-consult.ts`、本社だけに添える判断 = `src/consultation/projectless-consult-launch.ts`
  (`knowledgeContext` port)、配線 = `src/api/register-core.ts` (`consultKnowledgeContext`) / `src/bootstrap/core.ts`。

## 7. 相談チャンネルの後始末

**Requirement ID: `SPEC-CONSULT-CLOSURE`**

> 2026-10-02 neco 指示:「相談チャンネルは、起動から 24 時間が経過するか『セッション終了』または /end-session でセッション終了を
> 検知した後、内容がセンシティブなものかどうか確認し公開可能と判断した時チャンネルに『この内容を全体共有しますか？』の
> ダイアログを投稿する。セッションはこの回答を待たずに終了して良い。ユーザーの反応が 24 時間ない場合は NO と判断する。
> 回答が終わったらチャンネルを削除する」。推奨案 (承認ボタンはメンション無し / 公開できなければ即削除 / 子会社は問わない) で承認。

- きっかけ: セッションの終了・消失 (`session.ended` / `session.lost`)、または毎朝 1 回の見回り (既定 9 時、
  `CONCORDIA_CONSULT_CLOSURE_HOUR`) で開始から 24 時間を過ぎた相談のセッションを止める (`POST /v1/admin/stop-session/:id`)。
  見回りは毎朝なので、24 時間を過ぎてから片付くまで最大で 1 日近く残ってよい (「24 時間の掃除も毎朝の確認で行うので
  厳密には 24 時間以上放置されていても問題はない」2026-10-02 neco 指示)。相談セッションには自動確認も送らない (departments.md §9.6)。
- 判定 (本社だけ): 相談者の発言と最終回答を `claude -p` (会話のみ) に渡し、共有してよいか・書き直した題名と本文を JSON で受ける。
  読めない・欠けるは共有しない。要約に秘匿語辞書 (`CONCORDIA_CONFIDENTIAL_TERMS_FILE`、既定 Castra の
  `.claude/state/confidential-terms.json`) や Cc のプロジェクト名が残れば共有しない (語は記録せず件数だけ)。判定に失敗したら次の見回りでやり直す。
- 問い: 共有できるときだけ `POST /v1/consultations/:id/share-proposal` で候補を作り、相談チャンネルに
  「この内容を全体共有しますか？」カード (共有する / 直して共有 / 共有しない / 取り下げ) を出す。
  24 時間反応がなければ `POST /v1/consultations/publications/:id/expire` で「共有しない」(decided_by = timeout)。
- 片付け: 答えが出たら (共有・共有しない・取り下げ・期限切れ)、共有しないと判定したら、子会社なら、相談を終える (done)。
  **チャンネルは消さずに残す** (2026-10-06 neco 指示「プライベートの相談チャンネルは消すと見れなくなるから、セッションは消すけど
  チャンネルは残しておこうか。(技術相談についてはセッション再開可能にする) 消したいときは本人が消す感じで」。
  2026-10-02 の「24 時間のおそうじで一緒に消す」を置き換える)。見回りはチャンネルを削除しない。
- 閉じたときの案内: 実際に閉じたとき 1 回だけ、チャンネルへ「セッションを終了しました。このチャンネルは残ります」と
  「セッションを再開」「チャンネルを削除」のボタンを投稿する (`announceClosed`)。書き込みは従来どおり止める (§4 の lock)。
  投稿に失敗しても後始末は止めない。
- 再開 (相談者本人のみ): 相談を開き直し (`status=open`、24 時間の期限は再開時刻から数え直す、`wrap_status=pending`)、
  同じチャンネルを起動元にしてセッションを起動する。結び直し (`bindPrivateConsultSession`) が書き込みを戻す。
  部署が廃止済み・チャンネル削除済みなら再開しない。起動に失敗したら閉じ直してボタンを出し直す。
- 削除 (相談者本人と、その相談の権限者 = 管理者): セッションが止まっている相談だけ。`channel_deleted_at` を記録してから
  チャンネルを消す (2026-10-06 neco 指示「管理者は押せるようにしといて」)。権限者は再開できない。招待された人は再開も削除もできない。
- 子会社の Bot は許可した操作だけを受けるので、再開・削除のボタン (`consult:resume:` / `consult:delete:`) を
  `src/discord/subsidiary-scope.ts` の許可に入れる (入れ忘れると「このサーバではこの操作は利用できません」で断られる)。
- 復元 (2026-10-06 neco 指示「相談きてたチャンネル復元して。元の権限で」): 削除済みの相談は
  `POST /v1/consultations/:id/restore-channel` で作り直せる (削除済みでなければ 409)。API は
  `consultation.channel_restore_requested` を出し、相談の会社 (本社 = null) の Bot だけが処理する
  (`src/discord/consult-channel-restore.ts`)。Discord の元の投稿は戻らないので、除外済みを除くメンバーだけが見られる
  チャンネルを相談のカテゴリに作り、Cc に残る会話 (相談者の発言と最終回答、§7 の判定と同じ範囲) を再掲する。
  終了済みの相談は書き込みを止めて再開・削除のボタンを出す。`channel_id` を新しいチャンネルへ付け替え、削除の記録を外す。
  中身 (案内・会話) を先に入れ、仕上げ (ボタン・書き込みの停止) は最後にする。仕上げの各段階は 30 秒で打ち切り、段階名と結果を
  ログに残す (`restoreStep`)。途中で止まったときは `?mode=repost` (中身から入れ直す) か `?mode=finish` (仕上げだけ) でやり直す
  (2026-10-06、相談者が別の人の 2 件で仕上げが終わらなかった件の調査)。
- フォーラムでの公開相談 (部署フォーラムのスレッド) はこの後始末の対象外で、消さずに総務と同じくクローズして残す
  (「フォーラムでの公開相談は消すんじゃなくてクローズで残す」同日)。
- 状態は `private_consultations.wrap_status` (pending → asking → done、導入前の相談は legacy で対象外) が正本。
  1 段ずつ条件付きで進めるので、見回りとイベントが重なっても二重に問わない (CC-CONSULT-INV-09)。
- 手動の `/consult wrap` (§5) は残す。
- 相談のタイトルは変えない (2026-10-06 neco 指示「相談チャンネルはタイトルを変えないでほしい」): 技術相談フォーラムの
  スレッドもプライベート相談のチャンネルも、作業内容のタイトル・Haiku のタイトル要約 (`consultation-title.ts` は呼ばない)・
  作業段階の絵文字・起動モデルの絵文字のどれでも改名しない。

状態所有者: 後始末の状態 = `private_consultations` (consultation)。判断 = `src/consultation/closure-policy.ts`、
手順 = `closure-service.ts`、Discord・Cc API との接続 = `src/discord/consult-closure-wiring.ts`、
再開・削除の権限 = `src/consultation/private-consultation-service.ts` (`reopen` / `markChannelDeletedByOwner`)、
ボタン = `src/discord/consult-modal.ts` (`buildConsultClosedRow`) と `src/discord/consult-flow.ts` (`handleConsultLifecycle`)。

### 7.1 Consult 全体への終了・再開の共通案内 (SPEC-CONSULT-LIFECYCLE-GUIDANCE)

2026-10-19 neco 指示「ConsultにCcのセッション終了と再開の動きを共有する」「今後のConsult全体」。
価値 UX-CC-W6 / シナリオ UX-CC-S7。相談者が、終了後の再開と会話の引継ぎについて根拠のない説明を受ける状態を防ぐ。

- 相談の事前ヒアリングを伴う起動時の共通入力へ案内を載せる。本社・子会社、公開・プライベート、初回・再開で共通とし、相談以外へは載せない。
- 案内は consultation が所有し、dialogue-context が初回指示へ組み込む。寿命・期限・閲覧権限の状態所有者は既存の相談サービスと repository のまま。
- 不変条件 CC-CONSULT-INV-12: プライベート相談の24時間と定時確認、チャンネル維持、本人による再開と新規セッション起動を説明する。公開相談にはこの自動終了を一般化しない。
- 再開経路は最初の相談内容・前提を渡すが、旧セッションIDでのモデル再開や、以前の会話全文・要約の自動読込みは保証しない。Discordに過去の投稿が残ることとAIへの入力を区別する。
- 日付の変化・過去の質問への正答だけで終了の有無や全文/要約の引継ぎを推定しない。個別の終了・再開実績は記録未確認なら未確認と答え、不足する内容の再提示を頼む。
- 案内は今後の起動入力に適用する。既に稼働中の相談への一括送信・再起動や、会話履歴を復元する新機能は含まない。
- 検証: 共通案内の内容と、起動入力での相談/通常作業の分離を登録テストで確認する。復旧はこの案内と組込みを差し戻す。DB移行・状態変更は不要。

## 8. データ

| テーブル / 列 | 内容 | ドメイン |
|---|---|---|
| `use_cases.intake_enabled` | 事前ヒアリングの on / off | dialogue-context |
| `requester_profiles.role_title` | 役職 (次回の既定値) | dialogue-context |
| `consultation_intakes` | 相談ごとの 4 項目、取得元 (forum / modal / api)、会社・部署・ユースケース・依頼者、受付チャンネル (起動前に集めるので session id ではなくスレッド / チャンネルで辿る)。揃ってから起動するときに 1 行記録する | dialogue-context |
| `departments.settings_json.private` | プライベート相談の許可と権限者の最低役職 | governance |
| `private_consultations` | 会社・部署・相談者・チャンネル・セッション・状態 (pending_approval / open / closed)・承認前のヒアリング・承認者・時刻・後始末の状態 (wrap_status)・共有を問うた時刻・チャンネル削除時刻 (migration 122) | consultation |
| `private_consultation_members` | 閲覧者・追加理由 (requester / approver / invited)・追加者・時刻・除外時刻 | consultation |
| `consultation_publications` | 題名・候補文・公開した文・状態 (proposed / published / declined / withdrawn)・カードの message id・Tabula ページ id と URL・最後の失敗・判断者・時刻 | consultation |

## 9. 分割

| # | リポ | 内容 | task md |
|---|---|---|---|
| 1 | Cc | 事前ヒアリング | `spec/tasks/2026-09-30-consult-intake.md` |
| 2 | Cc | プライベート相談 | `spec/tasks/2026-09-30-consult-private.md` |
| 3 | Tb | 取り込み API の共有範囲指定 | Tabula の `spec/tasks/2026-09-30-import-member-sharing.md` (Tb の PR に含める) |
| 4 | Cc | オープン化の提案と Tabula 投稿 | `spec/tasks/2026-09-30-consult-publish-tabula.md` |
| 5 | Cc | 子会社の相談窓口 (プロジェクトを持たない相談) | `spec/tasks/2026-10-01-subsidiary-consult-desk.md` |
| 6 | Cc | 相談課の後始末と出力の絞り込み | `spec/tasks/2026-10-02-consult-closure.md` |
| 7 | Cc | 相談の「終了」と相談ログ | `spec/tasks/2026-10-03-consult-log-end.md` |
| 8 | Cc | モデル・サウンドのファイル受け渡し (Google Drive) | `spec/tasks/2026-10-14-consult-drive-transfer.md` |
