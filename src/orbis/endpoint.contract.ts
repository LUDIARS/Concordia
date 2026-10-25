export default {
  postThrow(error: unknown): boolean { return error instanceof Error && error.message === "orbis_unavailable"; },
  post(result: unknown, orbis: unknown, concordia: unknown): boolean {
    const r = result as { url: string; instanceId: string };
    const o = orbis as { port?: number; catalog_snapshot?: { port?: number } };
    const valid = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535;
    const port = valid(o.port) ? o.port : o.catalog_snapshot?.port;
    return valid(port) && r.url === `http://127.0.0.1:${port}/`
      && r.instanceId === (concordia as { instance_id?: string }).instance_id && !!r.instanceId;
  },
};
