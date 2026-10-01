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
| CC-CONSULT-INV-07 | その起動は本社の作業領域を cwd にしない。子会社ごとの空の相談用ディレクトリに固定し、要求側は場所・引数・provider を選べない。ツールは Web 検索と ToDo だけ | `resolveProjectlessConsultLaunch` + admin spawn |

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
- 閉じ込め (CC-CONSULT-INV-07)。Castra のハーネスフックは Castra 配下の一部ツールにしか掛からないため、
  起動する claude 本体で閉じる:
  - cwd は `<相談用ディレクトリの置き場所>/<子会社 id>` (空)。置き場所は `CONCORDIA_CONSULT_WORKSPACE_ROOT`、
    既定は `~/.concordia/consult-workspaces` (Castra の外。上位の CLAUDE.md を読ませない)。
  - claude の引数 `--tools=WebSearch,TodoWrite --strict-mcp-config --disable-slash-commands`。Read・シェル・編集・
    MCP・スキルを持たない。provider は claude だけ (他の provider は 400 `projectless_consult_requires_claude`)。
  - 起動要求に project / cwd / team / branch / worktree / 利用者の args / テンプレの prompt 注入があれば 400
    `projectless_consult_scope_fixed`。置き場所が未設定なら 503。
- 閲覧者: 社員名簿は本社と子会社で共通なので、名簿の権限者のうちその guild に在籍する人だけを閉じたチャンネルに入れる
  (居ない人の member overwrite はチャンネル作成ごと失敗させる)。在籍の確認に失敗したら受け付けない。
  名簿の外の人を足すことはできない。
- 子会社では公開候補 (`/consult wrap` と判断カード) を出さない。公開は本社の知見共有の面で、相談セッションはシェルも持たない。
- 残る露出: 起動時の共通資料案内 (Castra のパス名) はセッションに渡る。中身は読めない。

状態所有者: 相談用ディレクトリの場所 = 起動設定 (admin spawn)。判定 = consultation (`src/consultation/projectless-consult.ts`)。

## 7. データ

| テーブル / 列 | 内容 | ドメイン |
|---|---|---|
| `use_cases.intake_enabled` | 事前ヒアリングの on / off | dialogue-context |
| `requester_profiles.role_title` | 役職 (次回の既定値) | dialogue-context |
| `consultation_intakes` | 相談ごとの 4 項目、取得元 (forum / modal / api)、会社・部署・ユースケース・依頼者、受付チャンネル (起動前に集めるので session id ではなくスレッド / チャンネルで辿る)。揃ってから起動するときに 1 行記録する | dialogue-context |
| `departments.settings_json.private` | プライベート相談の許可と権限者の最低役職 | governance |
| `private_consultations` | 会社・部署・相談者・チャンネル・セッション・状態 (pending_approval / open / closed)・承認前のヒアリング・承認者・時刻 | consultation |
| `private_consultation_members` | 閲覧者・追加理由 (requester / approver / invited)・追加者・時刻・除外時刻 | consultation |
| `consultation_publications` | 題名・候補文・公開した文・状態 (proposed / published / declined / withdrawn)・カードの message id・Tabula ページ id と URL・最後の失敗・判断者・時刻 | consultation |

## 8. 分割

| # | リポ | 内容 | task md |
|---|---|---|---|
| 1 | Cc | 事前ヒアリング | `spec/tasks/2026-09-30-consult-intake.md` |
| 2 | Cc | プライベート相談 | `spec/tasks/2026-09-30-consult-private.md` |
| 3 | Tb | 取り込み API の共有範囲指定 | Tabula の `spec/tasks/2026-09-30-import-member-sharing.md` (Tb の PR に含める) |
| 4 | Cc | オープン化の提案と Tabula 投稿 | `spec/tasks/2026-09-30-consult-publish-tabula.md` |
| 5 | Cc | 子会社の相談窓口 (プロジェクトを持たない相談) | `spec/tasks/2026-10-01-subsidiary-consult-desk.md` |
