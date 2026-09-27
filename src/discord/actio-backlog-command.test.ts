import { describe, it, expect, vi } from "vitest";
import type { Interaction } from "discord.js";
import { backlogInput, handleBacklogCommand } from "./actio-backlog-command.js";

function interaction() {
  return { isChatInputCommand: () => true, isMessageContextMenuCommand: () => false,
    commandName: "backlog", guildId: "30001", channelId: "20001",
    options: { getSubcommand: () => "add", getString: (name: string) => name === "text" ? "改善案" : null },
    deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}), followUp: vi.fn(async () => ({ url: "https://discord.com/channels/30001/20001/10001" })) };
}
describe("Actio command publication", () => {
  it("requires exactly one input and rejects foreign message targets", () => {
    expect(backlogInput("x", "link", "30001", "20001")).toHaveProperty("error");
    expect(backlogInput(null, "https://discord.com/channels/30001/99999/10000", "30001", "20001")).toHaveProperty("error");
    expect(backlogInput(null, "https://discord.com/channels/30001/20001/10000", "30001", "20001")).toHaveProperty("text");
  });
  it("publishes one receipt only after live admission", async () => {
    const i = interaction(), admission = vi.fn(async () => true);
    await handleBacklogCommand(i as unknown as Interaction, admission);
    expect(admission).toHaveBeenCalledWith("30001", "20001");
    expect(i.followUp).toHaveBeenCalledTimes(1);
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: false, allowedMentions: { parse: [] }, embeds: [{ description: "改善案", footer: { text: "actio-backlog-command:v1" } }] }));
  });
  it("does not publish when admission fails or is absent", async () => {
    for (const admission of [undefined, async () => false, async () => { throw Error("private provider details"); }]) {
      const i = interaction(); await handleBacklogCommand(i as unknown as Interaction, admission);
      expect(i.followUp).not.toHaveBeenCalled(); expect(JSON.stringify(i.editReply.mock.calls)).not.toContain("private provider");
    }
  });
  it("never retries an unknown public send", async () => {
    const i = interaction(); i.followUp.mockRejectedValue(Error("network"));
    await handleBacklogCommand(i as unknown as Interaction, async () => true);
    expect(i.followUp).toHaveBeenCalledTimes(1); expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("投稿結果を確認できません"));
  });
  it("uses the message context target", async () => {
    const i = { ...interaction(), isChatInputCommand: () => false, isMessageContextMenuCommand: () => true, commandName: "バックログに追加", targetId: "10000" };
    await handleBacklogCommand(i as unknown as Interaction, async () => true);
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ embeds: [{ description: "https://discord.com/channels/30001/20001/10000", footer: { text: "actio-backlog-command:v1" } }] }));
  });
});
