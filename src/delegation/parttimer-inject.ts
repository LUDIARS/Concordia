/**
 * パートタイマー (category: "parttimer") の inject 本文の組み立て — 純関数。
 *
 * 背景 (2026-09-03 neco 指示): パートタイマーが仕事をしないことが多かった。 原因は
 * inject の書式で、 実装委託と同じ枠 (`buildImplementationInject` + 実装マニュアル) に
 * 押し込んでいたため、
 *
 *   - 実装ではないタスク (メール監視・カタログ更新・依存点検・朝礼) に
 *     「## 実装タスク」「### なぜ (why)」「着手時バンドル (ドメイン定義 → augur plan)」が付く
 *   - 完了条件が「仕様更新 / Anatomia ドメイン登録 / テスト / Revisor local PR 提出」固定で、
 *     読み取りだけのタスクでは 1 つも満たせない
 *   - 「サービスの起動・再起動はしない」 が本文の「Excubitor で start する」と正面衝突する
 *   - タスク本文が prompt file 195 行のうち 29 行 (15%) しかなく、 しかも中間に埋まる
 *   - 退勤指示 (本文中の完了時ステップ) と「PR 作成後は停止する」が二重に並ぶ
 *
 * という状態になっていた。 実際に `deps-sweep-daily` / `quaestor-mail-sweep` /
 * `kaizen-daily` / `vulnerability-response-daily` は「commit も PR もしない」タスクなのに
 * completion evidence (feature branch) が無いという理由で completed を failed に落とされていた。
 *
 * そこで書式を捨てて **タスク本文を先頭にそのまま置く** 形へ書き直す。 パートタイマーの
 * prompt_template は既に「何をするか」を自分で全部書いているので、 Concordia が足すのは
 *
 *   1. あなたはパートタイマーで、 上の本文が依頼の全文である (書かれていない手順を足さない)
 *   2. 迷っても止まらない
 *   3. 終わり方 — 報告 → status → 退勤。 成功でも失敗でも必ず最後まで
 *
 * の 3 点だけにする。 実装フォーマット (why / 着手時バンドル / 完了条件チェックリスト /
 * Memoria 起票 / コミット代行) はパートタイマーには一切載せない。
 *
 * spec/feature/delegation-parttimer-inject.md。
 */

export interface ParttimerInjectInput {
  runId: string;
  /** テンプレ title (見出しに使う)。 */
  title: string;
  /** タスク本文 (= rendered_prompt)。 加工せず先頭にそのまま置く。 */
  task: string;
  /** 協調 API のベース URL。 status 報告先の組み立てに使う。 */
  concordiaUrl: string;
  /**
   * 管理者メンション ID (`admin.mention_user_id`)。 Cc が解決済みの値を渡す。
   * 以前は「`GET /v1/admin/state` を引いて `<@${mention_user_id}>` を付けろ」と本文で
   * 指示していたが、 `${mention_user_id}` は変数展開で空へ潰れて `<@> ` という壊れた
   * 文字列がそのまま届いていた。 Cc が知っている値は Cc が埋める。
   */
  mentionUserId: string | null;
  /** 作業ディレクトリ。 null なら checkout を持たない run。 */
  cwd: string | null;
  /**
   * WebUI (/manuals) で編集できる kind「雑用」のマニュアル。 空なら節を作らない。
   * 運用で足したいルールはここへ書く (コード側の固定文言を増やさない)。
   */
  manual: string | null;
}

function validMentionUserId(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d{1,32}$/.test(trimmed) ? trimmed : null;
}

/**
 * パートタイマーの prompt 本文 (prompt file の中身そのまま)。
 *
 * @implements SPEC-DELEGATION-PARTTIMER-INJECT — Concordia が足すのはタスク本文 / 進め方 /
 *   終わり方の 3 点だけで、 実装委託の枠は載せない。
 *   (spec/feature/delegation-parttimer-inject.md §2.2)
 */
export function buildParttimerInject(input: ParttimerInjectInput): string {
  const base = input.concordiaUrl.replace(/\/+$/, "");
  const statusEndpoint = `${base}/v1/delegation/runs/${input.runId}/status`;
  const lines: string[] = [
    `# ${input.title}`,
    "",
    input.task.trim(),
    "",
    "---",
    "",
    "## 進め方",
    "",
    "あなたは Concordia が時間で起動したパートタイマーです。 上の本文が依頼の全文で、",
    "後から追加のタスク説明が届くことはありません。 本文に書かれていることをそのまま実行し、",
    "**書かれていない手順を足さないでください** — ブランチ作成・worktree・PR・テスト実行・",
    "仕様更新・ドメイン登録・Memoria 起票は、 本文が指示していなければ不要です",
    "(本文が指示しているなら、 そのとおりに行います)。",
    "",
    "本文の中で迷ったら止まらずに、 本文の目的に沿うほうを選んで進め、 選んだ理由を報告に",
    "1 行添えてください。 人に聞くのは **外部権限が必要なとき** と **取り返しのつかない操作**",
    "の 2 つだけです。 それ以外は自分で決めます。",
    "ただし本文が判断の留保・タスク化を指定している場合は、その条件を優先し、推測で実装せず記録して退勤します。",
    "",
    `サービスのポート・endpoint は Excubitor catalog / ProcessMap で解決します (ハードコードしない)。 協調 API は \`${base}\` (loopback) です。`,
    "人が読む文 (報告・投稿・質問) は日本語で書きます。",
  ];
  if (input.cwd) {
    lines.push(
      "",
      `作業対象は \`${input.cwd}\` です。 本文が変更を指示していない限り、 ファイルを書き換えません。`,
    );
  }
  if (input.manual?.trim()) {
    lines.push("", "### 運用ルール", "", input.manual.trim());
  }
  lines.push(
    "",
    "## 終わり方 (成功でも失敗でも必ず最後まで)",
    "",
    "1. **報告する。** 本文が求めている内容を書きます。 できなかったことがあれば、 隠さず",
    "   そのまま書きます。 途中で行き詰まった場合も、 そこまでの結果を報告します。",
    "   報告の送信までが仕事です。最終回答だけ書く、ファイルだけ保存する、statusだけ送ることでは報告完了になりません。",
    "   自分の Lictor sidecar `POST http://127.0.0.1:$LICTOR_PORT/v1/chat` へ",
    '   `{"channel":"system","text":"<作業結果とサマリ>"}` を UTF-8 JSON で送り、sidecarが解決するsystem送信先へ届けます。',
    "   対象・実行した作業・結果の件数/成果・未実施と理由を本文に含めます。0件は取得や確認を実行した根拠と併記し、未実行を「作業なし」にしません。",
    "   報告本文・caption・添付・statusには、認証情報、個人データ、メール本文、生ログやsession transcript、private endpoint、ローカル設定値、絶対パス、非公開成果物を転載しません。",
    "   対象や成果は必要最小限の名前・リポジトリ相対パス・匿名化した件数で示し、配送根拠にも送信先IDや秘密を含めません。",
    "   資料を共有する場合は同じ sidecar の `/v1/internal/send-file` へ files (絶対パス配列) と caption を送り、自分のセッションスレッドへ添付します。",
    "   filesは現在のworkspace rootまたはタスク用一時ディレクトリ内に限定します。外部入力のパスを未検証で使わず、範囲外・symlink・reparse point・秘密らしい名前は添付しません。",
    "   短い資料は全文、長い資料は要点をcaptionに載せ、全文はUTF-8の.txtを添付します。秘密情報は含めません。",
    "   API受付だけを到着済みとせず、送信先とDiscord投稿の配送記録を確認します。配送失敗・未確認は報告未完了として残します。",
    `2. **結果を Concordia に記録する。** \`POST ${statusEndpoint}\` を 1 回送ります。`,
    '   - 本文の実作業と報告の配送確認を最後までやれた: `{"status":"completed","result":"<報告の要約と配送根拠>"}`',
    '   - 途中まで: `{"status":"partial","remaining":[{"title":"<残り>"}]}`',
    '   - 報告の配送失敗・未確認: `{"status":"partial","remaining":[{"title":"完了報告の配送確認","kind":"wait","note":"<送信先・受付済み参照・失敗理由または未確認>"}]}`。作業や送信を重複実行せず照合に引き継ぎます。',
    '   - 実行そのものが失敗: `{"status":"failed","detail":"<理由>"}`',
    "   どれか 1 つを必ず送ります。 送らずに終わらないでください。",
    "   - **日本語を含む body はシェルに直書きしないでください。** Windows の一部のシェル経路では CP932 で",
    "     渡されて文字化けし、 化けた報告は受理されません (400 `garbled_report`)。 JSON を UTF-8 の",
    "     ファイルに書いて `curl.exe --data-binary @<file>` で送ります。",
    "3. **退勤する。** 記録まで済んだら、 自セッションの Lictor sidecar へ",
    "   `POST http://127.0.0.1:$LICTOR_PORT/v1/shutdown` を送ってセッションを終了します",
    "   (port は環境変数 `LICTOR_PORT`)。 **判断・確認・許可は要りません** (2026-09-01 neco 指示)。",
    "",
    "2 と 3 は結果にかかわらず必ず実行します。 やることが無かった / 設定が未投入 / 途中で失敗した —",
    "どの場合でも「その事実を報告 → status を送る → 退勤」で閉じてください。 次のタスクを自分で",
    "拾わない、 入力待ちで残らない、 人の返事を待たない。 残留した場合は Cc が猶予後に終了させます。",
  );
  const mentionUserId = validMentionUserId(input.mentionUserId);
  if (mentionUserId) {
    lines.push(
      "",
      `なお最終報告を Discord へ投稿するときは、 先頭に \`<@${mentionUserId}> \` を付けてください。`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
