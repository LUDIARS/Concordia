/**
 * 委託から Actio task を決める作業単位のキー (spec/feature/task-workflow-v3.md §work key)。
 *
 * 描画後の本文をキーにすると、引き継ぎで本文を書き直すたびに別の task ができる
 * (spec/faq/actio-cc-task-project-sync.md §2.3)。本文ではなく「何の作業か」を表す値で決める。
 */
import { repositoryKey } from "../taskflow/actio-binding.js";

export const TASKFLOW_REFERENCE = /^actio:[A-Za-z0-9-]+$/;

export type WorkUnit =
  | { kind: "reference"; reference: string }
  | { kind: "key"; sourceRef: string };

// パスの一部 (foo/spec/x.md) でなければ、直前が句読点や括弧でも拾う。
const SPEC_PATH = /(?<![\w./-])(spec\/[\w./-]+?\.md)\b/g;

function specPaths(value: string): string[] {
  return [...value.replace(/\\/g, "/").matchAll(SPEC_PATH)].map((match) => match[1]!);
}

/**
 * 作業を指す spec の md パス。依頼本文 (task 引数) は 1 行目だけを作業の指定とみなす。
 * 本文の 2 行目以降に挙がった spec は、前段のタスク md も設計ファイルも参考資料として扱い、
 * キーにしない。共通の前置きを持つ別々の委託が、参考として挙げた同じタスク md で
 * 1 つの Actio task に束ねられ task_execution_conflict になるのを防ぐため。
 * task 以外の引数 (context_extra など) に書かれたタスク仕様 (spec/tasks/) は、
 * 呼び出し側が明示した作業の指定として採る。
 */
export function specPathOf(args: Record<string, unknown>): string | null {
  const head = typeof args.task === "string" ? specPaths(args.task.trim().split(/\r?\n/)[0] ?? "") : [];
  const headTask = head.find((path) => path.startsWith("spec/tasks/"));
  if (headTask) return headTask;
  const explicit = Object.entries(args)
    .flatMap(([key, value]) => key !== "task" && typeof value === "string" ? specPaths(value) : []);
  const explicitTask = explicit.find((path) => path.startsWith("spec/tasks/"));
  if (explicitTask) return explicitTask;
  return head[0] ?? null;
}

/** 大文字小文字・空白・記号の揺れを吸収した題名。キーにだけ使い、表示には使わない。 */
export function normalizeWorkTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

/**
 * delegation_invoke の明示入力 taskflow_reference を args へ移す。
 * args にも別の参照があれば、どちらを続けるか決められないので拒否する。
 */
export function mergeTaskflowReference(
  args: Record<string, unknown>, reference: string | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (reference === undefined) return { ok: true, args };
  const existing = args.taskflow_reference;
  if (existing !== undefined && existing !== reference) return { ok: false, error: "taskflow_reference_conflict" };
  return { ok: true, args: { ...args, taskflow_reference: reference } };
}

/**
 * 1. taskflow_reference があればその task を再利用する。
 * 2. spec の md を指していれば work:<repoKey>:<path>。
 * 3. どちらも無ければ work:<repoKey>:<branch>:<題名の正規化>。
 */
export function resolveWorkUnit(input: {
  args: Record<string, unknown>; repoPath: string; branch: string | null; title: string;
}): WorkUnit {
  const reference = input.args.taskflow_reference;
  if (typeof reference === "string" && TASKFLOW_REFERENCE.test(reference.trim())) {
    return { kind: "reference", reference: reference.trim() };
  }
  const repoKey = repositoryKey(input.repoPath);
  const spec = specPathOf(input.args);
  if (spec) return { kind: "key", sourceRef: `work:${repoKey}:${spec}` };
  return { kind: "key", sourceRef: `work:${repoKey}:${input.branch ?? ""}:${normalizeWorkTitle(input.title)}` };
}
