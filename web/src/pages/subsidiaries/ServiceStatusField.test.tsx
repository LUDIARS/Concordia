// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api.js";
import { ServiceStatusField } from "./ServiceStatusField.js";
afterEach(() => { vi.restoreAllMocks(); });
describe("headquarters service visibility editor", () => {
  it("loads safe candidates and saves explicit site/service selections without JSON editing", async () => {
    vi.spyOn(api, "serviceStatusSettings").mockResolvedValue({ selection: { sites: ["peer:glab"], services: [] } });
    vi.spyOn(api, "serviceStatusCandidates").mockResolvedValue({ sites: [{ id: "peer:glab", name: "GLAB" }],
      services: [{ key: "peer%3Aglab/glab", siteId: "peer:glab", siteName: "GLAB", code: "glab", name: "GLAB API" }] });
    const save = vi.spyOn(api, "serviceStatusSave").mockImplementation(async (_id, selection) => ({ selection }));
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => { root.render(<ServiceStatusField subsidiaryId="glab" />); });
      expect(host.textContent).not.toContain("Restricted Site"); expect(host.querySelector("textarea")).toBeNull();
      const inputs = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(inputs[0]!.checked).toBe(true);
      await act(async () => { inputs[1]!.click(); });
      await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); });
      expect(save).toHaveBeenCalledWith("glab", { sites: ["peer:glab"], services: ["peer%3Aglab/glab"] });
    } finally { act(() => root.unmount()); host.remove(); }
  });
});
