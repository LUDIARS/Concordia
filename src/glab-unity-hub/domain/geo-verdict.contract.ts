/** @implements spec/feature/glab-unity-hub.md — C-3 evaluateGeo (guh-C-3) */
interface Input { cfCountry: string | null; cfConnectingIp: string | null; remoteAddress: string | null; allowedCountries: readonly string[]; policy: string }

function loopback(address: string | null): boolean {
  const value = (address ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  return value === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [input] = args as [Input];
    const verdict = result as { allow: boolean; overseas: boolean };
    const country = input.cfCountry?.trim().toUpperCase() || null;
    const viaCloudflare = country !== null || !!input.cfConnectingIp?.trim();
    if (!viaCloudflare) return verdict.allow === loopback(input.remoteAddress) && verdict.overseas === false;
    const allowed = country !== null && country !== "T1" && country !== "XX"
      && input.allowedCountries.map((code) => code.toUpperCase()).includes(country);
    if (allowed) return verdict.allow === true && verdict.overseas === false;
    return verdict.overseas === true && verdict.allow === (input.policy !== "block");
  },
};
