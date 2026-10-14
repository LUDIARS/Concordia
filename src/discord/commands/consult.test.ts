import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import consultCommand, { type ConsultCommandDeps } from "./consult.js";

function consultDeps(): ConsultCommandDeps {
  return {
    privateDepartments: () => [{ id: "dept_qa", name: "技術相談課" }, { id: "dept_hr", name: "人事相談" }],
    requesterDefaults: () => ({ skill_level: "中級", role_title: "エンジニア" }),
  } as unknown as ConsultCommandDeps;
}

function start(departmentId: string) {
  const showModal = vi.fn(async () => undefined);
  const reply = vi.fn(async () => undefined);
  const interaction = {
    user: { id: "111" },
    options: { getSubcommand: () => "start", getString: () => departmentId },
    showModal,
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, showModal, reply };
}

describe("/consult", () => {
  it("opens the intake modal for a private department with the requester defaults", async () => {
    const { interaction, showModal } = start("dept_qa");
    await consultCommand.execute(interaction, { consult: consultDeps() } as unknown as DiscordCommandDeps);
    const modal = (showModal.mock.calls[0] as unknown[])[0] as { toJSON(): { custom_id: string; components: unknown[] } };
    expect(modal.toJSON().custom_id).toBe("consult:modal:dept_qa");
    expect(JSON.stringify(modal.toJSON().components)).toContain("中級");
  });

  it("refuses a department that does not accept private consultations", async () => {
    const { interaction, showModal, reply } = start("dept_dev");
    await consultCommand.execute(interaction, { consult: consultDeps() } as unknown as DiscordCommandDeps);
    expect(showModal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("is unavailable where the consult deps are not wired (subsidiary bots)", async () => {
    const { interaction, reply } = start("dept_qa");
    await consultCommand.execute(interaction, {} as DiscordCommandDeps);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: "プライベート相談はこの Bot で使えません。" }));
  });

  it("registers the file transfer subcommands and routes them to the drive handlers", async () => {
    const json = consultCommand.builder.toJSON() as { options?: Array<{ name: string; options?: Array<{ name: string; required?: boolean }> }> };
    const names = (json.options ?? []).map((option) => option.name);
    expect(names).toEqual(expect.arrayContaining(["files", "files-sync"]));
    // The requester passes their own shared folder; no email address is asked for.
    const files = (json.options ?? []).find((option) => option.name === "files");
    expect(files?.options?.map((option) => [option.name, option.required ?? false])).toEqual([["folder", false]]);
    const reply = vi.fn(async () => undefined);
    const findByChannel = vi.fn(() => null);
    const interaction = {
      channelId: "chan-1",
      user: { id: "111" },
      options: { getSubcommand: () => "files-sync" },
      reply,
    } as unknown as ChatInputCommandInteraction;
    const deps = { ...consultDeps(), drive: { findByChannel, guide: vi.fn(), link: vi.fn(), sync: vi.fn() } } as unknown as ConsultCommandDeps;
    await consultCommand.execute(interaction, { consult: deps } as unknown as DiscordCommandDeps);
    expect(findByChannel).toHaveBeenCalledWith("chan-1");
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("says the file transfer is unavailable where the drive deps are not wired", async () => {
    const reply = vi.fn(async () => undefined);
    const interaction = { user: { id: "111" }, options: { getSubcommand: () => "files" }, reply } as unknown as ChatInputCommandInteraction;
    await consultCommand.execute(interaction, { consult: consultDeps() } as unknown as DiscordCommandDeps);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: "ファイル受け渡しはこの Bot で使えません。" }));
  });

  it("completes departments by name", async () => {
    const respond = vi.fn(async () => undefined);
    const interaction = { options: { getFocused: () => "人事" }, respond } as unknown as AutocompleteInteraction;
    await consultCommand.autocomplete!(interaction, { consult: consultDeps() } as unknown as DiscordCommandDeps);
    expect(respond).toHaveBeenCalledWith([{ name: "人事相談", value: "dept_hr" }]);
  });
});
