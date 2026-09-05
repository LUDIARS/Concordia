/**
 * 委託 run の作業 branch を単一情報源に束ねる。
 *
 * 2026-09-05 障害: 委託指示書の本文には「worktree 作成済み、 branch
 * feat/mail-realtime-pubsub」と書いてあったのに、 構造化フィールドの `branch`
 * は空だった。 誰も両者を突き合わせないため、 branch 指定は無いものとして
 * spawn され、 worktree も作られず共有 checkout へ着地した。
 *
 * 「本文だけが branch を指している」 のは、 呼び出し元が branch を渡し忘れた
 * ことの確実な兆候なので、 spawn 前に止める。 本文と構造化フィールドが食い違う
 * 場合も、 どちらが正なのか機械では決められないので止める。
 *
 * 優先順位は contract → 引数。 これは api/delegation.ts の既存規則
 * (`contract?.work_branch?.value ?? parsed.data.branch`) をそのまま単一の
 * 関数へ移したもので、 /v1/delegation/invoke と /v1/admin/spawn の 2 経路で
 * 挙動が割れていたのを揃える。
 */

/** branch 値がどこから来たか。 不一致時の診断に使う。 */
export type BranchSource = "contract" | "argument" | "none";

export interface BranchResolutionOk {
  ok: true;
  branch: string | null;
  source: BranchSource;
}

export interface BranchResolutionErr {
  ok: false;
  error: string;
}

export type BranchResolution = BranchResolutionOk | BranchResolutionErr;

export interface ResolveDelegationBranchInput {
  /** session contract の work_branch (最優先)。 */
  contractBranch?: string | null;
  /** 呼び出し元が明示した branch。 */
  argumentBranch?: string | null;
  /** 委託指示書の本文。 branch の言及を突き合わせるために読む。 */
  promptText?: string | null;
}

/**
 * 「branch」/「ブランチ」の直後に置かれた branch 名のうち、 *既に用意されている前提* で
 * 書かれたものを拾う。
 *
 * 拾わないもの:
 *
 * - 語を伴わない裸の `feat/xxx`。 指示書には `spec/feature/foo.md` のような path が
 *   普通に現れるため、 誤検知で spawn を止める方が害が大きい。
 * - 「委託先が自分で切れ」 という指示 (`Create branch chore/x off origin/main`,
 *   `ブランチ feat/x を作成する`)。 これは構造化 branch を渡さないのが正しい形で、
 *   実際に daily-review-autofix 等の seed テンプレがこの書き方をしている。
 *
 * 突き合わせたいのは 「Cc が worktree を用意したはずの branch」 だけ。
 */
export function findBranchMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const re = /(?:branch|ブランチ)\s*[:：]?\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._/-]{1,199})[`'"]?/gi;
  for (const match of text.matchAll(re)) {
    const candidate = match[1];
    if (!candidate) continue;
    // 文末の句読点や引用符を落とす。
    const cleaned = candidate.replace(/[.、。,)\]]+$/, "");
    if (!cleaned || !cleaned.includes("/")) continue; // `branch を切る` のような散文を除く
    if (isCreationInstruction(text, match.index ?? 0, cleaned.length)) continue;
    found.add(cleaned);
  }
  return [...found];
}

/** 直前 / 直後の語から「これから作れ」という指示かを判定する。 */
function isCreationInstruction(text: string, matchIndex: number, nameLength: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 40), matchIndex).toLowerCase();
  const after = text.slice(matchIndex, matchIndex + nameLength + 60);
  return (
    /(?:^|[^a-z])(create|creating|make|start|open|cut|checkout\s+-b|新しく|新規)\s*(a|an|the)?\s*(feature|work)?\s*$/i.test(before) ||
    /(を|は)?\s*(作成|新規作成|作って|切って|切る|作る)/.test(after)
  );
}

/**
 * contract / 引数 / 本文から作業 branch を決める。
 *
 * 本文だけが branch を指している、 または本文と構造化フィールドが食い違う場合は
 * `ok:false` を返して spawn を中止させる。
 */
export function resolveDelegationBranch(input: ResolveDelegationBranchInput): BranchResolution {
  const contractBranch = normalize(input.contractBranch);
  const argumentBranch = normalize(input.argumentBranch);
  const branch = contractBranch ?? argumentBranch;
  const source: BranchSource = contractBranch ? "contract" : argumentBranch ? "argument" : "none";
  const mentions = findBranchMentions(input.promptText);

  if (!branch) {
    if (mentions.length > 0) {
      return {
        ok: false,
        error:
          `task text names branch ${mentions.join(" / ")} but no branch was passed to the spawn. ` +
          "Pass it as the structured branch (contract work_branch or the branch argument) so a worktree is prepared.",
      };
    }
    return { ok: true, branch: null, source };
  }

  if (mentions.length > 0 && !mentions.includes(branch)) {
    return {
      ok: false,
      error:
        `branch mismatch: spawn uses ${branch} (${source}) but the task text names ${mentions.join(" / ")}. ` +
        "Make them agree before spawning.",
    };
  }
  return { ok: true, branch, source };
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
