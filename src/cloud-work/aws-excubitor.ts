import { resolveServicePort } from "../excubitor/service-port.js";
import { excubitorBaseUrl } from "../config/service-urls.js";
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

function loopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("cloud_aws_unavailable");
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  // Preserve explicitly structured refusals while bounding the body exactly as for a success response.
  return JSON.parse((await readCloudResponse(new Response(response.body), MAX_RESPONSE_BYTES)).toString("utf8"));
}

/** Discover the exact supervisor service entry and confirm the resolved listener before calling it. */
export async function resolveAwsExcubitor(env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<URL> {
  const discovery = loopbackOrigin(excubitorBaseUrl(env));
  const get = async (url: URL) => {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("cloud_aws_unavailable");
    }
    return readJson(response);
  };
  const service = await get(new URL("/api/v1/services/excubitor", discovery)) as Parameters<typeof resolveServicePort>[0] & { code?: string };
  const port = service?.code === "excubitor" ? resolveServicePort(service) : null;
  if (!port) throw new Error("cloud_aws_unavailable");
  const endpoint = new URL(discovery);
  endpoint.port = String(port);
  const health = await get(new URL("/health", endpoint)) as { service?: string } | null;
  if (health?.service !== "excubitor") throw new Error("cloud_aws_unavailable");
  return endpoint;
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
