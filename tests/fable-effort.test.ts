import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { delegationRouter } from "../src/api/delegation.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { seedDelegationTemplates } from "../src/delegation/seed.js";
import { DelegationService } from "../src/delegation/service.js";
import { makeTestDb } from "./helpers/db.js";

interface RuntimeOptionDto {
  key: string;
  choices?: Array<{ value: string }>;
}

interface TemplateDto {
  call_name: string;
  model: string | null;
  runtime_options: RuntimeOptionDto[];
}

interface InvokeResponseDto {
  run: {
    effort_level: string | null;
    effort_source: string | null;
  };
}

describe("Fable delegation reasoning effort", () => {
  let app: Hono;
  let promptsDir: string;
  let spawnCalls: Array<{ provider: string; args: string[] }>;

  beforeEach(() => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const sessions = new SessionsRepo(db);
    promptsDir = mkdtempSync(join(tmpdir(), "fable-effort-"));
    spawnCalls = [];
    seedDelegationTemplates(repo);

    const service = new DelegationService({
      repo,
      promptsDir,
      spawn: (request) => {
        spawnCalls.push({
          provider: request.provider,
          args: request.args ?? [],
        });
        return { ok: true, pid: 1, command: ["stub", request.provider] };
      },
    });
    app = new Hono();
    app.route("/v1/delegation", delegationRouter({ repo, service, sessions }));
  });

  afterEach(() => {
    rmSync(promptsDir, { recursive: true, force: true });
  });

  it("advertises medium and xhigh for both seeded Fable templates", async () => {
    const response = await app.request("/v1/delegation/templates");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { templates: TemplateDto[] };

    for (const callName of ["fable-mid", "fable-xhigh", "design-hard-fable5"]) {
      const template = body.templates.find((item) => item.call_name === callName);
      expect(template?.model).toBe("claude-fable-5");
      const effort = template?.runtime_options.find((option) => option.key === "effort");
      expect(effort?.choices?.map((choice) => choice.value)).toEqual(
        expect.arrayContaining(["medium", "xhigh"]),
      );
    }
  });

  it.each(["medium", "xhigh"] as const)(
    "accepts %s and resolves it to the Fable spawn arguments",
    async (effort) => {
      const response = await app.request("/v1/delegation/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          call_name: "fable-mid",
          args: {
            task: `exercise ${effort} effort`,
            target_repo: process.cwd(),
          },
          options: { effort },
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as InvokeResponseDto;
      expect(body.run).toMatchObject({
        effort_level: effort,
        effort_source: "one-shot",
      });
      expect(spawnCalls).toEqual([{
        provider: "claude",
        args: ["--model", "claude-fable-5", "--effort", effort],
      }]);
    },
  );

  it("rejects an unsupported Fable effort before spawning", async () => {
    const response = await app.request("/v1/delegation/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
          call_name: "fable-mid",
        args: {
          task: "exercise invalid effort validation",
          target_repo: process.cwd(),
        },
        options: { effort: "ultra" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid claude effort: ultra",
    });
    expect(spawnCalls).toEqual([]);
  });
});
