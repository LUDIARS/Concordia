// @vitest-environment jsdom
// Discord チャット中継の中継トークンの操作面。 値は読み返さないので「設定済みかどうかだけを映す」
// 「貼った値を target を指定して保存し、画面に残さない」「消去できる」を押さえる。
// @implements spec/feature/discord-chat-relay.md — 中継トークン
import { afterEach, describe, expect, it, vi } from "vitest";
// jest-dom の matcher は root vitest 実行では expect に載らないので、素の matcher だけで書く。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscordChatRelayTargetSecrets } from "../../../api.js";
import { DiscordChatRelaySecretsSection, type DiscordChatRelaySecretsClient } from "./DiscordChatRelaySecretsSection.js";

/** テスト値 (実物ではない)。 */
const PASTED = "example-relay-token";

function makeClient(targets: DiscordChatRelayTargetSecrets[]) {
  const client = {
    discordChatRelayTargets: vi.fn(async () => ({ targets })),
    discordChatRelaySetToken: vi.fn(async () => ({ ok: true })),
    discordChatRelayClearToken: vi.fn(async () => ({ ok: true })),
  };
  return client as typeof client & DiscordChatRelaySecretsClient;
}

const mf: DiscordChatRelayTargetSecrets = {
  name: "mf", enabled: true, channel_ids: ["123456789012345678"], relay_token_set: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DiscordChatRelaySecretsSection", () => {
  it("target ごとにチャンネルと設定済みかどうかだけを出す", async () => {
    render(<DiscordChatRelaySecretsSection client={makeClient([mf, { ...mf, name: "off", relay_token_set: true }])} />);
    await screen.findByText("mf");
    expect(screen.getAllByText("未設定")).toHaveLength(1);
    expect(screen.getAllByText("設定済み")).toHaveLength(1);
    expect(screen.getAllByText("123456789012345678")).toHaveLength(2);
  });

  it("貼った値を target を指定して保存し、入力欄には残さない", async () => {
    const client = makeClient([mf]);
    const user = userEvent.setup();
    render(<DiscordChatRelaySecretsSection client={client} />);
    await screen.findByText("mf");
    await user.click(screen.getByRole("button", { name: "入力" }));
    await user.type(screen.getByPlaceholderText(/サービス側/), PASTED);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.discordChatRelaySetToken).toHaveBeenCalledWith("mf", PASTED));
    await waitFor(() => expect(screen.queryByPlaceholderText(/サービス側/)).toBeNull());
    expect(document.body.textContent ?? "").not.toContain(PASTED);
  });

  it("設定済みの値を消去できる", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = makeClient([{ ...mf, relay_token_set: true }]);
    const user = userEvent.setup();
    render(<DiscordChatRelaySecretsSection client={client} />);
    await screen.findByText("mf");
    await user.click(screen.getByRole("button", { name: "消去" }));
    await waitFor(() => expect(client.discordChatRelayClearToken).toHaveBeenCalledWith("mf"));
  });

  it("target が無ければ登録先を案内する", async () => {
    render(<DiscordChatRelaySecretsSection client={makeClient([])} />);
    expect(await screen.findByText(/target がありません/)).not.toBeNull();
  });
});
