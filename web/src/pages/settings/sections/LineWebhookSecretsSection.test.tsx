// @vitest-environment jsdom
// LINE webhook の秘密値の操作面。 値は読み返さないので「設定済みかどうかだけを映す」
// 「貼った値を target と項目を指定して保存し、画面に残さない」「消去できる」を押さえる。
// @implements spec/feature/line-webhook-relay.md — チャネルの秘密値
import { afterEach, describe, expect, it, vi } from "vitest";
// jest-dom の matcher は root vitest 実行では expect に載らないので、素の matcher だけで書く。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LineWebhookTargetSecrets } from "../../../api.js";
import { LineWebhookSecretsSection, type LineWebhookSecretsClient } from "./LineWebhookSecretsSection.js";

/** テスト値 (実物ではない)。 */
const PASTED = "example-channel-secret";

function makeClient(targets: LineWebhookTargetSecrets[]) {
  const client = {
    lineWebhookTargets: vi.fn(async () => ({ targets })),
    lineWebhookSetSecret: vi.fn(async () => ({ ok: true })),
    lineWebhookClearSecret: vi.fn(async () => ({ ok: true })),
  };
  return client as typeof client & LineWebhookSecretsClient;
}

const mf: LineWebhookTargetSecrets = {
  name: "mf", enabled: true, channel_secret_set: false, channel_access_token_set: true, relay_token_set: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LineWebhookSecretsSection", () => {
  it("target ごとに設定済みかどうかだけを出す", async () => {
    render(<LineWebhookSecretsSection client={makeClient([mf])} />);
    await screen.findByText("mf");
    expect(screen.getAllByText("未設定")).toHaveLength(2);
    expect(screen.getAllByText("設定済み")).toHaveLength(1);
  });

  it("貼った値を target と項目を指定して保存し、入力欄には残さない", async () => {
    const client = makeClient([mf]);
    const user = userEvent.setup();
    render(<LineWebhookSecretsSection client={client} />);
    await screen.findByText("mf");
    await user.click(screen.getAllByRole("button", { name: "入力" })[0]!);
    await user.type(screen.getByPlaceholderText(/チャネル基本設定/), PASTED);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.lineWebhookSetSecret).toHaveBeenCalledWith("mf", "channel_secret", PASTED));
    await waitFor(() => expect(screen.queryByPlaceholderText(/チャネル基本設定/)).toBeNull());
    expect(document.body.textContent ?? "").not.toContain(PASTED);
  });

  it("設定済みの値を消去できる", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = makeClient([mf]);
    const user = userEvent.setup();
    render(<LineWebhookSecretsSection client={client} />);
    await screen.findByText("mf");
    await user.click(screen.getByRole("button", { name: "消去" }));
    await waitFor(() => expect(client.lineWebhookClearSecret).toHaveBeenCalledWith("mf", "channel_access_token"));
  });

  it("target が無ければ登録先を案内する", async () => {
    render(<LineWebhookSecretsSection client={makeClient([])} />);
    expect(await screen.findByText(/target がありません/)).not.toBeNull();
  });
});
