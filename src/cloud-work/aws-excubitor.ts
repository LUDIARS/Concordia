import { resolveExcubitorManagement } from "./excubitor-management.js";
import { readCloudResponse } from "./artifact-transfer.js";
import { AwsJobPage, AwsJobSchema, AwsRefusal, AwsTargetList, type AwsJob } from "./aws-excubitor-schema.js";
import { matchAwsJob, type AwsJobIdentity } from "./aws-policy.js";

export interface AwsSubmit {
  target_id: string; job_id: string; runner: string; inputs: Record<string, string>; deadline: string;
}
export type AwsSubmitResult = { job: AwsJob } | { refused: string };
export interface AwsExcubitor {
  targets(): Promise<ReturnType<typeof AwsTargetList.parse>>;
  submit(input: AwsSubmit): Promise<AwsSubmitResult>;
  reconcile(identity: AwsJobIdentity): Promise<AwsJob | undefined>;
  observe(operationId: string): Promise<AwsJob>;
  cancel(operationId: string): Promise<AwsJob>;
}
type ExResponse = { status: number; body: unknown };
type ExRequest = (path: string, input?: AwsSubmit | "cancel") => Promise<ExResponse>;
const PAGE_SIZE = 100;
const MAX_JOB_PAGES = 20;
const MAX_RESPONSE_BYTES = 2_000_000;

async function readJson(response: Response): Promise<unknown> {
  // Preserve explicitly structured refusals while bounding the body exactly as for a success response.
  return JSON.parse((await readCloudResponse(new Response(response.body), MAX_RESPONSE_BYTES)).toString("utf8"));
}

/** Discover the exact supervisor service entry and confirm the resolved listener before calling it. */
export async function resolveAwsExcubitor(env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<URL> {
  try { return await resolveExcubitorManagement(env, fetcher, readJson); }
  catch { throw new Error("cloud_aws_unavailable"); }
}

export function awsExcubitorTransport(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): AwsExcubitor {
  async function call<T>(operation: (adapter: AwsExcubitor) => Promise<T>): Promise<T> {
    const endpoint = await resolveAwsExcubitor(env, fetcher);
    const operationTimeout = AbortSignal.timeout(20_000);
    return operation(awsExcubitorAdapter(async (path, input) => {
      const response = await fetcher(new URL("/api/v1/aws-compute" + path, endpoint), {
        redirect: "error", signal: AbortSignal.any([operationTimeout, AbortSignal.timeout(10_000)]),
        method: input ? "POST" : "GET",
        ...(input && input !== "cancel" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
      });
      return { status: response.status, body: await readJson(response) };
    }));
  }
  return {
    targets: () => call(adapter => adapter.targets()),
    submit: input => call(adapter => adapter.submit(input)),
    reconcile: identity => call(adapter => adapter.reconcile(identity)),
    observe: id => call(adapter => adapter.observe(id)),
    cancel: id => call(adapter => adapter.cancel(id)),
  };
}

export function awsExcubitorAdapter(request: ExRequest): AwsExcubitor {
  const get = async (path: string) => {
    const result = await request(path);
    if (result.status !== 200) throw new Error("cloud_aws_unavailable");
    return result.body;
  };
  const jobPath = (id: string) => "/jobs/" + encodeURIComponent(id);
  return {
    async targets() { return AwsTargetList.parse(await get("/targets")); },
    async submit(input) {
      const { status, body } = await request("/jobs", input);
      if (status === 200 || status === 202) return { job: AwsJobSchema.parse(body) };
      const refusal = AwsRefusal.safeParse(body);
      if ([400, 404, 409, 503].includes(status) && refusal.success) return { refused: refusal.data.error };
      // A conflict on the same job key may identify an existing provider job.
      throw new Error("cloud_aws_submission_unknown");
    },
    async reconcile(identity) {
      const keyed = new Map<string, AwsJob>();
      for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
        const { jobs } = AwsJobPage.parse(await get(`/jobs?active=false&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`));
        for (const job of jobs) {
          if (job.job_id === identity.requestId) keyed.set(job.operation_id, job);
        }
        // Ex enforces a unique job_id. Cc also verifies the target/runner before binding it.
        if (jobs.length < PAGE_SIZE || keyed.size > 0) break;
      }
      return matchAwsJob([...keyed.values()], identity);
    },
    async observe(id) { return AwsJobSchema.parse(await get(jobPath(id))); },
    async cancel(id) {
      const { status, body } = await request(jobPath(id) + "/cancel", "cancel");
      if (status !== 200 && status !== 202) throw new Error("cloud_aws_unavailable");
      return AwsJobSchema.parse(body);
    },
  };
}
