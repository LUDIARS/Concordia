import { expect, it, vi } from "vitest";
import { consultationSafetyRouter } from "./consultation-safety.js";
import { ConsultationSafetyService } from "../consultation/safety-service.js";

it("validates the active session and request before checking content", async () => {
  const classify = vi.fn(async () => '{"decision":"allow","category":"none"}');
  const service = new ConsultationSafetyService({ isConsultation: () => true, confidentialTerms: async () => [],
    classify, record: () => "audit", notify: () => {} });
  const app = consultationSafetyRouter(service, id => id === "active");
  for (const [body, status] of [[{ session_id: "ended", phase: "prompt", text: "x" }, 404],
    [{ session_id: "active", phase: "unknown", text: "x" }, 400]] as const) {
    const response = await app.request("/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(status);
  }
  expect(classify).not.toHaveBeenCalled();
  const response = await app.request("/check", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "active", phase: "prompt", text: "general education" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ blocked: false });
  expect(classify).toHaveBeenCalledOnce();
});
