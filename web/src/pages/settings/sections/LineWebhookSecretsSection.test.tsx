// @vitest-environment jsdom
// LINE webhook の設定面。 秘密値は読み返さないので「設定済みかどうかだけを映す」
// 「貼った値をチャネル / サービスと項目を指定して保存し、画面に残さない」「消去できる」、
// 呼びかけの言葉の保存、 トークごとの紐付けの「ふだんの相手」変更と解除を押さえる。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面
import { afterEach, describe, expect, it, vi } from "vitest";
// jest-dom の matcher は root vitest 実行では expect に載らないので、素の matcher だけで書く。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LineTalkLink, LineWebhookChannel, LineWebhookService } from "../../../api.js";
import { LineWebhookSecretsSection, splitKeywords, type LineWebhookSecretsClient } from "./LineWebhookSecretsSection.js";

/** テスト値 (実物ではない)。 */
const PASTED = "example-channel-secret";

const channel: LineWebhookChannel = {
  name: "ludiars", webhook_path: "/hooks/line/ludiars", services: ["mf", "mm"],
  channel_secret_set: false, channel_access_token_set: true,
};
const mf: LineWebhookService = { name: "mf", channel: "ludiars", enabled: true, keywords: ["おてつだい"], relay_token_set: true };
const mm: LineWebhookService = { name: "mm", channel: "ludiars", enabled: true, keywords: [], relay_token_set: false };
const link: LineTalkLink = {
  id: 7, channel: "ludiars", talk_kind: "group", talk_id_prefix: "C0123", service: "mm", is_default: false, linked_at: 1,
};

function makeClient(data: { channels?: LineWebhookChannel[]; services?: LineWebhookService[]; links?: LineTalkLink[] } = {}) {
  const ok = vi.fn(async () => ({ ok: true }));
  const client = {
    lineWebhookChannels: vi.fn(async () => ({ channels: data.channels ?? [channel] })),
    lineWebhookServices: vi.fn(async () => ({ services: data.services ?? [mf, mm] })),
    lineWebhookLinks: vi.fn(async () => ({ links: data.links ?? [link] })),
    lineWebhookSetChannelSecret: vi.fn(async () => ({ ok: true })),
    lineWebhookClearChannelSecret: ok,
    lineWebhookSetRelayToken: vi.fn(async () => ({ ok: true })),
    lineWebhookClearRelayToken: vi.fn(async () => ({ ok: true })),
    lineWebhookSetKeywords: vi.fn(async (_service: string, keywords: string[]) => ({ ok: true, keywords })),
    lineWebhookSetDefaultLink: vi.fn(async () => ({ ok: true })),
    lineWebhookRemoveLink: vi.fn(async () => ({ ok: true })),
  };
  return client as typeof client & LineWebhookSecretsClient;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LineWebhookSecretsSection", () => {
  it("チャネルの Webhook の経路と、チャネル・サービスごとに設定済みかどうかだけを出す", async () => {
    render(<LineWebhookSecretsSection client={makeClient()} />);
    await screen.findByText("チャネル ludiars");
    expect(document.body.textContent ?? "").toContain("/hooks/line/ludiars");
    // チャネルシークレット・mm の中継トークンが未設定、 アクセストークン・mf の中継トークンが設定済み。
    expect(screen.getAllByText("未設定")).toHaveLength(2);
    expect(screen.getAllByText("設定済み")).toHaveLength(2);
  });

  it("貼った値をチャネルと項目を指定して保存し、入力欄には残さない", async () => {
    const client = makeClient();
    const user = userEvent.setup();
    render(<LineWebhookSecretsSection client={client} />);
    await screen.findByText("チャネル ludiars");
    await user.click(screen.getAllByRole("button", { name: "入力" })[0]!);
    await user.type(screen.getByPlaceholderText(/チャネル基本設定/), PASTED);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.lineWebhookSetChannelSecret).toHaveBeenCalledWith("ludiars", "channel_secret", PASTED));
    await waitFor(() => expect(screen.queryByPlaceholderText(/チャネル基本設定/)).toBeNull());
    expect(document.body.textContent ?? "").not.toContain(PASTED);
  });

  it("サービスの中継トークンを保存し、設定済みの値を消去できる", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = makeClient({ channels: [{ ...channel, channel_access_token_set: false }] });
    const user = userEvent.setup();
    render(<LineWebhookSecretsSection client={client} />);
    await screen.findByText("サービス mm");
    // mf の中継トークンだけが設定済みなので「消去」 は 1 つ。
    await user.click(screen.getByRole("button", { name: "消去" }));
    await waitFor(() => expect(client.lineWebhookClearRelayToken).toHaveBeenCalledWith("mf"));
    const inputs = screen.getAllByRole("button", { name: "入力" });
    await user.click(inputs[inputs.length - 1]!);
    await user.type(screen.getByPlaceholderText(/サービス側/), "example-relay-token");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.lineWebhookSetRelayToken).toHaveBeenCalledWith("mm", "example-relay-token"));
  });

  it("呼びかけの言葉を「、」区切りで保存する", async () => {
    const client = makeClient();
    const user = userEvent.setup();
    render(<LineWebhookSecretsSection client={client} />);
    await screen.findByText("サービス mm");
    await user.click(screen.getAllByRole("button", { name: "編集" })[1]!);
    await user.type(screen.getByLabelText("mm の呼びかけの言葉"), "メモリア、 きろく");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.lineWebhookSetKeywords).toHaveBeenCalledWith("mm", ["メモリア", "きろく"]));
    expect(splitKeywords("a, b，c\n")).toEqual(["a", "b", "c"]);
  });

  it("紐付けはトーク ID の先頭だけを出し、ふだんの相手の変更と解除ができる", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = makeClient();
    const user = userEvent.setup();
    render(<LineWebhookSecretsSection client={client} />);
    await screen.findByText(/C0123…/);
    await user.click(screen.getByRole("button", { name: "ふだんの相手にする" }));
    await waitFor(() => expect(client.lineWebhookSetDefaultLink).toHaveBeenCalledWith(7));
    await user.click(screen.getByRole("button", { name: "解除" }));
    await waitFor(() => expect(client.lineWebhookRemoveLink).toHaveBeenCalledWith(7));
  });

  it("サービスが無ければ登録先を案内する", async () => {
    render(<LineWebhookSecretsSection client={makeClient({ channels: [], services: [], links: [] })} />);
    expect(await screen.findByText(/サービスがありません/)).not.toBeNull();
  });
});
