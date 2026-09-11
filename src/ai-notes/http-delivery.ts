import type { SendResult } from "./model.js";

/** Errors contain stable codes only; response bodies and credentials never escape this adapter. */
export class DeliveryFault extends Error {
  constructor(readonly code: string, readonly unknown: boolean = false) { super(code); }
}

export async function deliveryJson(input: {
  url: string; authorization: string; body?: unknown; fetcher: typeof fetch;
}): Promise<unknown> {
  const writing = input.body !== undefined;
  let response: Response;
  try {
    response = await input.fetcher(input.url, {
      method: writing ? "POST" : "GET",
      headers: { authorization: input.authorization, "content-type": "application/json" },
      ...(writing ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
  } catch { throw new DeliveryFault("transport_unavailable", writing); }
  if (!response.ok) throw new DeliveryFault(`http_${response.status}`, writing && (response.status >= 500 || response.status === 408));
  try { return await response.json(); }
  catch { throw new DeliveryFault("invalid_response", writing); }
}

export function failedDelivery(error: unknown, writing: boolean): SendResult {
  return { status: error instanceof DeliveryFault ? (error.unknown ? "unknown" : "failed") : (writing ? "unknown" : "failed"),
    error_code: error instanceof DeliveryFault ? error.code : "invalid_response" };
}
