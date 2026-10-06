import { createHash } from "node:crypto";

interface VisibilitySite { name: string; self: boolean }
interface VisibilityService { code: string; name: string; project: string | null; repository: string | null }

export interface ServiceVisibilityPolicy {
  restrictedSites: ReadonlySet<string>;
  restrictedServices: ReadonlySet<string>;
  restrictedServicePrefixes: ReadonlySet<string>;
  headOfficeOnlyServices: ReadonlySet<string>;
  headOfficeOnlyServicePrefixes: ReadonlySet<string>;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const token = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokenDigest = (value: string): string => digest(token(value));
const digestSet = (values: readonly string[]): ReadonlySet<string> => new Set(values.map(tokenDigest));

/** Test/configuration helper. Production exclusions remain opaque in the public repository. */
export function createServiceVisibilityPolicy(input: {
  restrictedSites?: readonly string[];
  restrictedServices?: readonly string[];
  restrictedServicePrefixes?: readonly string[];
  headOfficeOnlyServices?: readonly string[];
  headOfficeOnlyServicePrefixes?: readonly string[];
}): ServiceVisibilityPolicy {
  return {
    restrictedSites: digestSet(input.restrictedSites ?? []),
    restrictedServices: digestSet(input.restrictedServices ?? []),
    restrictedServicePrefixes: digestSet(input.restrictedServicePrefixes ?? []),
    headOfficeOnlyServices: digestSet(input.headOfficeOnlyServices ?? []),
    headOfficeOnlyServicePrefixes: digestSet(input.headOfficeOnlyServicePrefixes ?? []),
  };
}

/**
 * Centrally approved publication exclusions, represented only by one-way digests so the
 * repository does not disclose the identifiers that the policy protects.
 */
export const defaultServiceVisibilityPolicy: ServiceVisibilityPolicy = {
  restrictedSites: new Set([
    "46692c1a9785f8412679121f6c064c050a9d6265578b6743ae143ee0e2493c04",
  ]),
  restrictedServices: new Set([
    "68dbf73d03d3a5107edad3b05676eee240e68c280296e52b6986873c54cef3cb",
    "59548661e252a6f235e5d2da3e691a4d02d3729716a025f19de0af07638a70d3",
    "ef003433a4626a7652eef9d6540e1eb0dc5dae41fe04b5e15d81f3b1e3519762",
    "e5a08ffd3d7509c66e79642edbdcd8ed889269a7164c718afca541304188423d",
    "b944fc0984e689314e11bef2ad5c6f58ec2fc24edc9468d2a37eb2fafc3e1af2",
  ]),
  restrictedServicePrefixes: new Set([
    "714b7d387445cb24e7c18d7d456db001bd6eada4984aeb07585a0a177d41f37b",
    "5b43d069733262999e9fb8403e00179f40f00b4f622177d2b2cfde4e812b7596",
    "51f50b2ef98fe4b1d550c64dced87abd9806b6b9a6db7492e9a8a47f95f0e7b0",
    "80f88a7b7573da0c26f8ef1a89beb058e181bfc171e0ccf45eb6451bc5667d1d",
  ]),
  headOfficeOnlyServices: new Set([
    "8fa1dddd53606ceb933c5c6a12e714ed41e11d37a2b7bc48e91d15b54171d033",
  ]),
  headOfficeOnlyServicePrefixes: new Set([
    "0c9a4577a1c63a51c8d3f37e14dce6c0737026e1445701c80a563c8014385cc0",
  ]),
};

function matchesPrefix(value: string, prefixes: ReadonlySet<string>): boolean {
  const normalized = token(value);
  for (let length = 1; length <= normalized.length; length++) {
    if (prefixes.has(digest(normalized.slice(0, length)))) return true;
  }
  return false;
}

export function publicSite(site: VisibilitySite, policy: ServiceVisibilityPolicy): boolean {
  return !policy.restrictedSites.has(tokenDigest(site.name));
}

export function publicService(service: VisibilityService, site: VisibilitySite, policy: ServiceVisibilityPolicy): boolean {
  if (!publicSite(site, policy)) return false;
  const identifiers = [
    service.code,
    service.name,
    service.project ?? "",
    service.repository?.split(/[\\/]/).at(-1)?.replace(/\.git$/i, "") ?? "",
  ].filter(Boolean);
  if (identifiers.some((identifier) => policy.restrictedServices.has(tokenDigest(identifier))
    || matchesPrefix(identifier, policy.restrictedServicePrefixes))) return false;
  return !(site.self && identifiers.some((identifier) => policy.headOfficeOnlyServices.has(tokenDigest(identifier))
    || matchesPrefix(identifier, policy.headOfficeOnlyServicePrefixes)));
}
