function expectedEndpoint(orbis: unknown, concordia: unknown): { url: string; instanceId: string } | null {
  const o = orbis as { port?: unknown; catalog_snapshot?: { port?: unknown } | null } | null;
  const port = o?.catalog_snapshot?.port !== undefined ? o.catalog_snapshot.port : o?.port;
  const instance = (concordia as { instance_id?: unknown } | null)?.instance_id;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof instance !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instance)) return null;
  return { url: `http://127.0.0.1:${port}/`, instanceId: instance };
}

export default {
  postThrow(error: unknown, orbis: unknown, concordia: unknown): boolean {
    return expectedEndpoint(orbis, concordia) === null
      && error instanceof Error && error.message === "orbis_unavailable";
  },
  post(result: unknown, orbis: unknown, concordia: unknown): boolean {
    const r = result as { url: string; instanceId: string };
    const expected = expectedEndpoint(orbis, concordia);
    return expected !== null && r.url === expected.url && r.instanceId === expected.instanceId;
  },
};
