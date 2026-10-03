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
| CC-CONSULT-INV-07 | その起動は本社の作業領域を cwd にしない。役職ごとの作業ディレクトリに固定し、要求側は場所・引数・provider を選べない。ツールは Web 検索と ToDo だけ | `resolveProjectlessConsultLaunch` + admin spawn |
| CC-CONSULT-INV-08 | 相談セッションは上位の CLAUDE.md / AGENTS.md と自動メモリを読まない (社内のプロジェクト名を回答に持ち込まない。Castra のメモリやワークフローを引き継がない) | 役職フォルダの `.claude/settings.local.json` (`claudeMdExcludes` / `autoMemoryEnabled:false`) + `CLAUDE_CODE_DISABLE_AUTO_MEMORY` |
| CC-CONSULT-INV-11 | 相談セッションは provider に関わらず、役職フォルダの指示 (AGENTS.md / CLAUDE.md とスキル) を受け取る。載せるのは役職フォルダ自身のものだけ (上位のフォルダ・相談者のデータフォルダの中は読まない) | claude は自分で読む。それ以外は admin spawn が初回指示に載せる (`needsInlineRoleGuidance` / `buildRoleGuidanceBlock` (`src/consultation/role-guidance.ts`)、`loadInlineRoleGuidance` と読み込み先の `ROLE_GUIDANCE_INSTRUCTION_FILES` / `ROLE_GUIDANCE_SKILL_DIRS` (`src/consultation/role-guidance-files.ts`)) |
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
    - 返信を 1 度受けたら目的だけのためには再度聞かない。必須が欠ければ同じスレッドで最大 3 回まで聞き返す。
    - 承認カード (起動権限の無い投稿者) は項目が揃ってから出す。承認後の再入で欠けていたら起動しない。
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
  3. 本人が起動権限 (社員名簿の `session_spawn`) を持てばそのまま起動する。持たなければチャンネル内に
     「起動を承認」ボタンを出し、起動権限を持つ権限者が押すと起動する (承認者もこのチャンネルの閲覧者なので、
     承認のために内容を外へ出さない)。
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
  - 役職フォルダ自身の指示ファイルとスキルは役職ごとの使い分けのために読ませる。中身は人が置く。置き場所は Codex と Claude Code の
    共有配置 (2026-10-03 neco 指示「Codex と Claude Code が同じものを読む」): 指示は `<役職>/AGENTS.md` と `<役職>/CLAUDE.md`
    (同じ内容。Codex は AGENTS.md、Claude Code は CLAUDE.md を読む)、スキルは `<役職>/.agents/skills/<名前>/SKILL.md`
    (旧 `.claude/skills/` は廃止)。
    相談で使う環境のメモリは別途指定する (自動メモリは使わない)。
  - 相談者のデータは役職フォルダの下に Discord の個人 ID のフォルダ (`<役職>/<Discord ID>/`) を作って保存する。場所は起動 env
    `CONCORDIA_CONSULT_DATA_DIR` で渡す。Discord 以外からの起動 (ID が無い) では作らない。
  - 本社: 起動要求がプロジェクト・cwd・チーム等を指定していなければここで起動する (指定があればそれに従う)。
    ツールの制限と設定フォルダは子会社と同じ (2026-10-02 neco 指示「本社の相談も同じで」)。プロジェクト無しでは cwd を決められず起動に失敗していた (`project cwd is required`) のを直す。
- モデル (2026-10-02 neco 指示「エンジニアと企画の相談は Opus、デザイナーとサウンドの相談は Astra で起動。モデルとエフォートは
  自動 (medium)」「GLab も Astra」): 相談部署の起動で、要求がテンプレート・provider・モデルを明示していなければ、事前ヒアリングの
  役職から選ぶ。デザイナー・アート・サウンド → Astra (`astra-mid`、codex)、それ以外 (エンジニア・企画・不明) → Opus
  (`opus-5-5-movable`)。effort は medium。テンプレート名は `CONCORDIA_CONSULT_OPUS_TEMPLATE` / `CONCORDIA_CONSULT_ASTRA_TEMPLATE`
  で差し替えられる。部署フォーラムからの相談でもモデルを聞き返さない (`src/consultation/consult-model.ts`)。
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
  - claude の引数 `--tools=WebSearch,TodoWrite,Skill --strict-mcp-config`。Read・シェル・編集・利用者の MCP を持たない。
  - claude は相談専用の設定フォルダ (`<置き場所>/.claude-config`) を `CLAUDE_CONFIG_DIR` にして起動する。利用者の ~/.claude
    (Castra のワークフローを含むスキル・CLAUDE.md・設定) を読まず、スキルは役職フォルダ (`<役職>/.agents/skills`) のものだけを使う
    (2026-10-02 neco 選択「設定を分けて使えるようにする」)。役職フォルダの信頼はその設定フォルダの `.claude.json` に Cc が書く
    (Lictor の事前焼き込みは ~/.claude.json にしか書かないため)。ログイン情報もその設定フォルダに持つ。未ログインなら claude の
    相談は 503 `projectless_consult_claude_login_required` (初回は人が `CLAUDE_CONFIG_DIR=<設定フォルダ> claude` でログインする)。
    Lictor のフック (ハーネスのゲート) は `--settings` で渡るので、設定フォルダを分けても効く。
    transcript も設定フォルダの `projects` に書かれるので、Cc は起動時にそこを Claude Code のログ親として登録し
    (`setExtraClaudeProjectRoots`)、予算・コスト報告・ログ集計で相談の消費を数える (2026-10-03 修正、それまでは 0 だった)。
  - codex (Astra) の引数 `-s read-only --disable shell_tool --disable plugins -c project_doc_max_bytes=0 -c mcp_servers={}`。
    codex の読み取り専用 sandbox は Windows でファイルの読み取りを止めない (2026-10-02 実測) ため、読む手段のシェルそのものを外し、
    AGENTS.md・プラグイン・MCP も読ませない。画像を読む view_image はパスを指定すれば画像を読める余地が残る。
  - 指示ファイルを読めない provider では、役職フォルダの指示ファイルとスキルを Cc が初回指示に載せる (CC-CONSULT-INV-11、
    2026-10-02 neco 指示「役職は spawn 前に決定するので読み分けで良い」)。上の引数のため Astra (codex) は役職フォルダの
    CLAUDE.md もスキルも読めず、デザイナー・サウンドの相談者だけ役職ごとの回答の作り方 (技術レベルに合わせる・非公開の内容を
    検索語に入れない・できない依頼の断り方など) が効かない回答を受け取っていた。
    - 対象は相談の作業ディレクトリで起動し、解決後の provider が claude 以外のとき (`needsInlineRoleGuidance`)。claude は自分で
      読むので載せない (二重になる)。テンプレート経路・provider 直指定の経路とも、provider の解決後に組む。
    - 読むのは役職フォルダ直下の指示ファイル 1 つとスキルフォルダ 1 つの `<名前>/SKILL.md` だけ。読み込み先は共有配置
      (`AGENTS.md`、`.agents/skills`) → 旧配置 (`CLAUDE.md`、`.claude/skills`) の順に、先に見つかったものだけを読む (両方あれば
      共有配置だけ。同じ内容・同じスキルを二重に載せない。`ROLE_GUIDANCE_INSTRUCTION_FILES` / `ROLE_GUIDANCE_SKILL_DIRS`)。
      相談者のデータフォルダや上位のフォルダは読まない
      (CC-CONSULT-INV-08 と同じ範囲)。無い・読めないファイルはその分を載せずに起動を続け、読めなかったものは warn ログに名前だけ出す。
    - 置き場所は「作業範囲の制限」の直後、対話の前提データの前。見出し `## 相談窓口の前提と手順` に続けて「このセッションではスキルを
      呼び出せません。『〜を読んでください』とある手順は、下に全文を載せています」の 1 行、指示ファイルの本文、スキルごとの
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

状態所有者: 作業ディレクトリの場所 = 起動設定 (admin spawn)。役職の区分 = consultation (`src/consultation/consult-role.ts`)。判定 = consultation (`src/consultation/projectless-consult.ts`)。役職の指示を初回指示に載せるか・その組み立て = consultation (`src/consultation/role-guidance.ts`)、読み込み = `src/consultation/role-guidance-files.ts`。

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
  チャンネルはすぐには消さず、次の見回り (24 時間のおそうじ) でまとめて削除する (「速攻消さずに 24 時間のおそうじで
  一緒に消す」2026-10-02 neco 指示)。削除に失敗したら次の見回りで再試行する。
- フォーラムでの公開相談 (部署フォーラムのスレッド) はこの後始末の対象外で、消さずに総務と同じくクローズして残す
  (「フォーラムでの公開相談は消すんじゃなくてクローズで残す」同日)。
- 状態は `private_consultations.wrap_status` (pending → asking → done、導入前の相談は legacy で対象外) が正本。
  1 段ずつ条件付きで進めるので、見回りとイベントが重なっても二重に問わない (CC-CONSULT-INV-09)。
- 手動の `/consult wrap` (§5) は残す。

状態所有者: 後始末の状態 = `private_consultations` (consultation)。判断 = `src/consultation/closure-policy.ts`、
手順 = `closure-service.ts`、Discord・Cc API との接続 = `src/discord/consult-closure-wiring.ts`。

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
