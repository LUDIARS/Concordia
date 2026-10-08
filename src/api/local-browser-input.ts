/** Shared pure input vocabulary for the browser policy and its observe predicate. */
export interface BrowserInput {
  method: string; url: string; host: string | undefined; origin: string | undefined;
  fetchSite: string | undefined; contentType: string | undefined; allowedOrigins: readonly string[];
}
