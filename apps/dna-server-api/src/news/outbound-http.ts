import type { Http } from "./http.ts";
import type { Store } from "../db/store.ts";
import { reserve, settle } from "./budgets.ts";
import { checkedUrl } from "./network-policy.ts";

export function httpKind(url: string) {
  const host = new URL(url).hostname;
  return host === "api.firecrawl.dev"
    ? "firecrawl"
    : /(bing\.com|google\.com|duckduckgo\.com|hn\.algolia\.com)/.test(host)
      ? "search"
      : "http";
}
/** Fixture transports have no internal retry; liveHttp reserves inside each
 * low-level request, including every redirected hop. */
export function budgetedHttp(store: Store, http: Http): Http {
  const run = async (url: string, fn: () => ReturnType<Http["get"]>) => {
    checkedUrl(url);
    const kind = httpKind(url),
      id = reserve(store, kind, new URL(url).origin + new URL(url).pathname);
    try {
      const result = await fn();
      settle(store.db, id, { amount: 0, source: "mock" });
      return result;
    } catch (error) {
      settle(store.db, id, { status: "unknown" });
      throw error;
    }
  };
  return {
    get: (url, options) => run(url, () => http.get(url, options)),
    postJson: (url, body, headers, options) => {
      if (body && typeof body === "object" && "url" in body) checkedUrl(String((body as any).url));
      return run(url, () => http.postJson(url, body, headers, options));
    },
    ...(http.postForm
      ? {
          postForm: (url: string, form: string, options: any) =>
            run(url, () => http.postForm!(url, form, options)),
        }
      : {}),
  };
}
