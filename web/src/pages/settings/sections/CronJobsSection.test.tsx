// @vitest-environment jsdom
// 定時ジョブ欄の宛先の切替 (spec/feature/parttimer-agent-dispatch.md CC-PT-AGENT-INV-06)。
// data builder の無いジョブは外部エージェントを選べず、 選べるジョブは宛先の PUT を送ること、
// 戻しの分を保存できることを押さえる。
// @implements spec/feature/parttimer-agent-dispatch.md — 宛先の切替 UI
import { afterEach, describe, expect, it, vi } from "vitest";
// jest-dom の matcher は root vitest 実行では expect に載らないので、素の matcher だけで書く。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CronJobsSection } from "./CronJobsSection.js";

const jobs = [
  { name: "deps-sweep-daily", cron: "10 7 * * *", default_call_name: "deps-sweep-daily", call_name: "deps-sweep-daily", agent: "", agent_supported: true },
  { name: "vulnerability-response-daily", cron: "10 5 * * *", default_call_name: "vulnerability-response-daily", call_name: "vulnerability-response-daily", agent: "", agent_supported: false },
];

function stubFetch() {
  const puts: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }
    if (url === "/v1/admin/cron-jobs") return new Response(JSON.stringify({ jobs }));
    if (url === "/v1/delegation/templates") return new Response(JSON.stringify({ templates: [] }));
    if (url === "/v1/admin/cron-jobs-agent-fallback") return new Response(JSON.stringify({ minutes: 180 }));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return puts;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CronJobsSection の宛先", () => {
  it("data builder の無いジョブでは外部エージェントの選択肢が無効になる", async () => {
    stubFetch();
    render(<CronJobsSection />);
    const unsupported = await screen.findByLabelText("vulnerability-response-daily の宛先") as HTMLSelectElement;
    const options = Array.from(unsupported.options);
    expect(options.filter((option) => option.disabled).map((option) => option.value)).toEqual(["dots", "muse"]);
    const supported = screen.getByLabelText("deps-sweep-daily の宛先") as HTMLSelectElement;
    expect(Array.from(supported.options).some((option) => option.disabled)).toBe(false);
  });

  it("宛先を選ぶと宛先の PUT を送り、 戻しの分を保存できる", async () => {
    const puts = stubFetch();
    render(<CronJobsSection />);
    const select = await screen.findByLabelText("deps-sweep-daily の宛先");
    await userEvent.selectOptions(select, "dots");
    await waitFor(() => expect(puts).toContainEqual({ url: "/v1/admin/cron-jobs/deps-sweep-daily/agent", body: { agent: "dots" } }));
    const minutes = screen.getByLabelText(/Cc の委託へ戻すまで/u);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "60");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(puts).toContainEqual({ url: "/v1/admin/cron-jobs-agent-fallback", body: { minutes: 60 } }));
  });
});
