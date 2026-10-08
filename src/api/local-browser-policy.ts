import { contract } from './ontime-runtime.js'; /* augur-inject:import:264dfc2e */
import augurContract_69f59eb3 from './local-browser.contract.js'; /* augur-inject:contract-predicate:d80d7747 */
import type { BrowserInput } from './local-browser-input.js';
export type { BrowserInput } from './local-browser-input.js';
/** Browser request policy, not local process authentication. Forwarded headers are not trusted. */
export function localBrowserDecision(input: BrowserInput): string | null {
  try {
    const request = new URL(input.url);
    const host = input.host;
    if (!host || host !== request.host || /[\s,@/#?\\]/.test(host)) return 'local_host_denied';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(request.hostname);
    if (!local && !input.allowedOrigins.includes(request.origin)) return 'local_host_denied';
    if (input.fetchSite === 'cross-site') return 'local_cross_site_denied';
    if (input.origin !== undefined && (input.origin === 'null'
      || (input.origin !== request.origin && !input.allowedOrigins.includes(input.origin)))) return 'local_origin_denied';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(input.method)
      && input.contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') return 'local_json_required';
    return null;
  } catch { return 'local_host_denied'; }
}
// @ts-expect-error augur-inject
localBrowserDecision = contract(localBrowserDecision, { ...augurContract_69f59eb3, contractId: 'cc-security-C-23', mode: 'observe', sample: 1, where: 'src/api/local-browser-policy.ts:6', rule: 'contract-wrap', id: '69f59eb3' }); /* augur-inject:contract-wrap:69f59eb3 */
