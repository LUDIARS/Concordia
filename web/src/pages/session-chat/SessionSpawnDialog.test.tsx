// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../components/DelegationSpawnForm.js", () => ({
  DelegationSpawnForm: ({ subsidiaryId, department, onSpawned }: { subsidiaryId: string | null; department: { id: string } | null; onSpawned: () => void }) =>
    <button onClick={onSpawned}>起動 {subsidiaryId ?? "hq"}/{department?.id ?? "default"}</button>,
}));

beforeEach(() => {
  // Mirror the real dialog: showModal opens it. jsdom hides <dialog> without [open], which
  // makes its options inaccessible to role queries.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("session spawn location dialog", () => {
  it("offers departments only in the selected company and closes on successful launch", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes("departments")
      ? { departments: [{ id: "hq-dev", subsidiary_id: null, name: "本社開発", archived: false }, { id: "sub-general", subsidiary_id: "sub", name: "子会社総務", archived: false }] }
      : { subsidiaries: [{ id: "sub", name: "Subsidiary", display_name: "子会社 A" }] }))));
    // The root vitest run shares the module registry across files (isolate: false), so an earlier
    // file may already hold SessionSpawnDialog bound to the real DelegationSpawnForm. Reload it
    // after the mock is registered.
    vi.resetModules();
    const { SessionSpawnDialog } = await import("./SessionSpawnDialog.js");
    const onClose = vi.fn();
    render(<SessionSpawnDialog onClose={onClose} />);
    await screen.findByRole("option", { name: "本社開発" });
    expect(screen.queryByRole("option", { name: "子会社総務" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("起動先の会社"), "sub");
    expect(screen.queryByRole("option", { name: "本社開発" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("起動部署"), "sub-general");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "起動 sub/sub-general" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
