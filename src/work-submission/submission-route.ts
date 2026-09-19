// 作業成果を main へ渡す経路の判定 (純関数)。 規則の説明は
// spec/feature/work-submission.md §3 が単一情報源。
//
// なぜここに置くか: 同じ分岐が Castra のフック・Cc の API・スキル文書に写されており、
// どれかが古くなると「正規手段で出したのに止められる」「止めるべきものが素通りする」が
// 起きる。 workflow を知っているのは project 登録を持つ Cc だけなので、 判定は Cc に
// 1 つだけ置き、 フックは結果を読むだけにする。

import { resolve, sep } from "node:path";

export type SubmissionRouteName = "direct-main" | "revisor-local-pr" | "github-pr" | "unregistered";

export interface SubmissionRouteInput {
  /** `git rev-parse --show-toplevel` の結果 */
  repoPath: string;
  /** project 登録の revisor_workflow */
  workflow: "revisor" | "github" | null;
  /** Revisor にリポジトリ登録があるか */
  registered: boolean;
  /** ワークスペースルート (Castra) の絶対パス */
  workspaceRoots: readonly string[];
  /** main へ直接コミットする例外リポジトリ (Villa 等) の絶対パス */
  directMainRepos?: readonly string[];
}

export interface SubmissionRoute {
  route: SubmissionRouteName;
  /** GitHub PR (gh pr create) がこの経路の正規手段か */
  allowsGithubPr: boolean;
  /** 作業ブランチを GitHub へ push してよいか */
  allowsBranchPush: boolean;
  /** 提出先の Cc endpoint。 経路が提出を持たないときは null */
  submitEndpoint: string | null;
  /** 人間とフックに見せる一行。 経路ごとに何をすべきかを述べる */
  guidance: string;
}

function normalize(path: string): string {
  const resolved = resolve(path);
  const trimmed = resolved.endsWith(sep) && resolved.length > 1 ? resolved.slice(0, -sep.length) : resolved;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function matches(path: string, candidates: readonly string[]): boolean {
  const target = normalize(path);
  return candidates.some((candidate) => candidate.trim() !== "" && normalize(candidate) === target);
}

/** @implements SPEC-WORK-SUBMISSION-ROUTE */
export function resolveSubmissionRoute(input: SubmissionRouteInput): SubmissionRoute {
  if (matches(input.repoPath, input.workspaceRoots) || matches(input.repoPath, input.directMainRepos ?? [])) {
    return {
      route: "direct-main",
      allowsGithubPr: false,
      allowsBranchPush: false,
      submitEndpoint: null,
      guidance: "このリポジトリはローカル main へ直接コミットする。feature branch も PR も作らない。",
    };
  }
  if (input.workflow === "revisor") {
    return {
      route: "revisor-local-pr",
      allowsGithubPr: false,
      allowsBranchPush: false,
      submitEndpoint: "/v1/implementation-tools/submit",
      guidance: "Revisor Workflow のプロジェクト。GitHub PR は作らず、Cc 経由で local PR を提出する。",
    };
  }
  if (input.workflow === "github") {
    return {
      route: "github-pr",
      allowsGithubPr: true,
      allowsBranchPush: true,
      submitEndpoint: null,
      guidance: "GitHub Workflow のプロジェクト。revisor push でブランチを送り、GitHub PR を作る。",
    };
  }
  // 登録が無ければ workflow を決められない。 どちらかに寄せて自動で進めると、
  // 公開してはいけない変更が GitHub へ出る側へ倒れうるので、 人間に返す。
  return {
    route: "unregistered",
    allowsGithubPr: false,
    allowsBranchPush: false,
    submitEndpoint: null,
    guidance: input.registered
      ? "Revisor には登録があるが workflow が未設定。/projects で workflow を設定する。"
      : "Cc の /projects に未登録のリポジトリ。登録するか、提出方法を人間に確認する。",
  };
}
