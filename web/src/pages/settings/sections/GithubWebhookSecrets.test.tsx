// @vitest-environment jsdom
// 貼り付け・削除の操作面。 値そのものは画面にしか無いので、
// 「短すぎる値を往復させない」「保存後に残さない」「remote 無しには操作を出さない」を押さえる。
// @implements spec/feature/github-issue-workflow.md — webhook secret
import { afterEach, describe, expect, it, vi } from "vitest";
// jest-dom の matcher は root vitest 実行では expect に載らない (web/node_modules 側の
// vitest を掴むため)。 素の matcher だけで書く。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GithubIssueWorkflowStatus } from "../../../api.js";
import { GithubWebhookSecrets } from "./GithubWebhookSecrets.js";

const apiMocks = vi.hoisted(() => ({
  githubIssueWorkflowSetSecret: vi.fn(),
  githubIssueWorkflowClearSecret: vi.fn(),
}));

vi.mock("../../../api.js", () => ({ api: apiMocks }));

const REPO = "https://github.com/LUDIARS/Concordia.git";
/** テスト値 (実物ではない)。 16 文字以上。 */
const PASTED = "pasted-webhook-secret";

function status(over: Partial<GithubIssueWorkflowStatus> = {}): GithubIssueWorkflowStatus {
  return {
    webhook_secret_set: true,
    webhook_secret_error: null,
    label: "Cc",
    trusted_actors: [],
    base_branch: "main",
    fix_call_name: "github-issue-fix",
    poll_interval_min: 5,
    projects: [
      { code: "Cc", project: "Concordia", repo_origin: REPO, webhook_secret_set: false },
      { code: "X", project: "NoRemote", repo_origin: null, webhook_secret_set: false },
    ],
    actors: [],
    ...over,
  };
}

function renderSecrets(over: Partial<GithubIssueWorkflowStatus> = {}) {
  const onError = vi.fn();
  const onChanged = vi.fn(async () => {});
  render(
    <GithubWebhookSecrets status={status(over)} disabled={false} onChanged={onChanged} onError={onError} />,
  );
  return { onError, onChanged };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GithubWebhookSecrets", () => {
  it("貼り付けた値をリポジトリ指定で保存し、 入力欄には残さない", async () => {
    apiMocks.githubIssueWorkflowSetSecret.mockResolvedValue({ ok: true, secret: null });
    const { onChanged } = renderSecrets();

    // 共通行 → プロジェクト行の順に出るので、 2 つ目が Concordia の「貼り付け」。
    await userEvent.click(screen.getAllByRole("button", { name: "貼り付け" })[1]);
    const input = screen.getByPlaceholderText("GitHub 側の webhook secret を貼る");
    await userEvent.type(input, PASTED);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(apiMocks.githubIssueWorkflowSetSecret).toHaveBeenCalledWith({ secret: PASTED, repo: REPO });
      expect(onChanged).toHaveBeenCalled();
      // 保存できたら入力欄ごと畳む — 貼った値を画面へ残さない。
      expect(screen.queryByPlaceholderText("GitHub 側の webhook secret を貼る")).toBeNull();
    });
  });

  it("短すぎる secret はサーバへ送らず理由を返す", async () => {
    const { onError } = renderSecrets();

    await userEvent.click(screen.getAllByRole("button", { name: "貼り付け" })[0]);
    await userEvent.type(screen.getByPlaceholderText("GitHub 側の webhook secret を貼る"), "short");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(apiMocks.githubIssueWorkflowSetSecret).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("16"));
  });

  it("削除は確認を取ってから repo を指して消す (取消なら何もしない)", async () => {
    apiMocks.githubIssueWorkflowClearSecret.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSecrets({
      projects: [{ code: "Cc", project: "Concordia", repo_origin: REPO, webhook_secret_set: true }],
    });

    const remove = () => screen.getAllByRole("button", { name: "削除" })[1];
    await userEvent.click(remove());
    expect(apiMocks.githubIssueWorkflowClearSecret).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await userEvent.click(remove());
    await waitFor(() => {
      expect(apiMocks.githubIssueWorkflowClearSecret).toHaveBeenCalledWith({ repo: REPO });
    });
    confirm.mockRestore();
  });

  it("remote 未登録のプロジェクト行には操作を出さない", () => {
    renderSecrets();

    expect(screen.getByText("(remote 未登録)")).toBeTruthy();
    // 共通 1 本 + remote のある Concordia の 1 本だけ。
    expect(screen.getAllByRole("button", { name: "貼り付け" })).toHaveLength(2);
  });
});
