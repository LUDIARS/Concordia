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

  it("completes departments by name", async () => {
    const respond = vi.fn(async () => undefined);
    const interaction = { options: { getFocused: () => "人事" }, respond } as unknown as AutocompleteInteraction;
    await consultCommand.autocomplete!(interaction, { consult: consultDeps() } as unknown as DiscordCommandDeps);
    expect(respond).toHaveBeenCalledWith([{ name: "人事相談", value: "dept_hr" }]);
  });
});
