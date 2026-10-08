import type { BrowserInput } from './local-browser-input.js';
export default { post(result: string | null, input: BrowserInput): boolean {
  if (result !== null) return true;
  return input.fetchSite !== 'cross-site' && input.origin !== 'null'
    && (['GET', 'HEAD', 'OPTIONS'].includes(input.method)
      || input.contentType?.split(';')[0].trim().toLowerCase() === 'application/json');
} };
