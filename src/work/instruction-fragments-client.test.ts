import { beforeEach, expect, it, vi } from "vitest";
import { createInstructionFragmentSync } from "./instruction-fragments-client.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../developer-tools/service-http.js", () => ({ ToolServiceHttp: class { request = request; } }));
vi.mock("../taskflow/repository-identity.js", () => ({ mainRepositoryKey: async () => "/repo" }));
beforeEach(() => request.mockReset());
const input = { repo: "/repo", origin: null, reference: "actio:T", title: "Feature", body: "1. Add table" };

it("does not create a project when no Pf registration matches", async () => {
  request.mockResolvedValueOnce({ projects: [{ id: "cc", rootPath: "/repo" }] })
    .mockResolvedValueOnce({ items: [], total: 0 });
  const result = await createInstructionFragmentSync({ findService: vi.fn() })(input);
  expect(result).toEqual({ state: "not_registered" });
  expect(request).toHaveBeenCalledTimes(2);
});
it("reports an unverified receipt as unavailable instead of registration success", async () => {
  request.mockResolvedValueOnce({ projects: [{ id: "cc", rootPath: "/repo" }] })
    .mockResolvedValueOnce({ items: [{ id: "p", anatomiaRepo: "cc" }], total: 1 })
    .mockResolvedValueOnce({ fragment: { id: "f", content: "different", sourceEventId: "wrong" } });
  expect(await createInstructionFragmentSync({ findService: vi.fn() })(input)).toEqual({ state: "unavailable" });
  expect(request).toHaveBeenCalledTimes(3);
});
