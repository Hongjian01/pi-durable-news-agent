// Outbound HTTP for sources and articles: timeout, size cap, named User-Agent, retries on transient failures.
import { HttpError, isRetryable, retryAfterMs, withRetry } from "@dna/sdk";
import type { Logger } from "@dna/sdk/node";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { resolvePublic, UnsafeUrl } from "./network-policy.ts";
import { reserve, settle, BudgetExceeded } from "./budgets.ts";
import { httpKind } from "./outbound-http.ts";
import type { Store } from "../db/store.ts";
import { execution } from "../db/execution.ts";
import { imageCost } from "./images.ts";

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
}

export interface GetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /** Return 304 and other non-2xx responses instead of throwing (conditional GET). */
  allowStatus?: number[];
  /** Statuses that are not retried (a rate limit or block the caller handles itself). */
  noRetryOn?: number[];
}

export interface Http {
  get(url: string, options?: GetOptions): Promise<HttpResponse>;
  postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    options?: { timeoutMs?: number },
  ): Promise<HttpResponse>;
  /** A form POST (application/x-www-form-urlencoded). Live only: fixtures leave it out. */
  postForm?(url: string, form: string, options?: GetOptions): Promise<HttpResponse>;
}

export const USER_AGENT =
  "durable-news-agent/0.1 (+https://github.com/disler/pi-durable-news-agent)";

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("response_body_limit");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Native request pins a validated DNS address to the socket, closing the
 * validate-then-resolve-again rebinding window. Size is checked after decoding. */
export async function publicFetch(
  input: string,
  init: RequestInit = {},
  maxBytes = 1024 * 1024,
  options: { store?: Store; allowPrivateForTests?: boolean; kind?: string } = {},
  hops = 0,
): Promise<Response> {
  if (hops > 5) throw new Error("redirect_limit");
  init = { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) };
  const pinned =
    options.allowPrivateForTests && hops === 0 && !execution.getStore()
      ? { url: new URL(input), address: "127.0.0.1", family: 4 }
      : await resolvePublic(input, undefined, init.signal ?? undefined);
  const kind = options.kind ?? httpKind(input);
  const reservation = options.store
    ? reserve(options.store, kind, pinned.url.origin + pinned.url.pathname)
    : undefined;
  try {
    const response = await new Promise<{ status: number; headers: Headers; body: Buffer }>(
      (resolve, reject) => {
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        const request = (pinned.url.protocol === "https:" ? httpsRequest : httpRequest)(
          pinned.url,
          {
            method: init.method ?? "GET",
            headers: { "accept-encoding": "gzip, deflate, br", ...headers },
            signal: init.signal ?? undefined,
            lookup: ((_host: string, lookupOptions: any, callback: any) =>
              lookupOptions.all
                ? callback(null, [{ address: pinned.address, family: pinned.family }])
                : callback(null, pinned.address, pinned.family)) as any,
          },
          async (res) => {
            const status = res.statusCode ?? 500;
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value !== undefined)
                responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
            if ([301, 302, 303, 307, 308].includes(status)) {
              res.destroy();
              resolve({ status, headers: responseHeaders, body: Buffer.alloc(0) });
              return;
            }
            const encoding = res.headers["content-encoding"];
            const decoder =
              encoding === "gzip"
                ? createGunzip()
                : encoding === "deflate"
                  ? createInflate()
                  : encoding === "br"
                    ? createBrotliDecompress()
                    : undefined;
            const stream = decoder ? res.pipe(decoder) : res;
            if (decoder) res.on("error", (error) => decoder.destroy(error));
            try {
              let size = 0;
              const chunks: Buffer[] = [];
              for await (const value of stream) {
                const chunk = Buffer.from(value);
                size += chunk.length;
                if (size > maxBytes) {
                  res.destroy();
                  stream.destroy();
                  throw new Error("response_body_limit");
                }
                chunks.push(chunk);
              }
              resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) });
            } catch (error) {
              reject(error);
            }
          },
        );
        request.on("error", reject);
        if (init.body) {
          if (typeof init.body !== "string" && !Buffer.isBuffer(init.body)) {
            request.destroy();
            reject(new Error("Unsupported outbound request body"));
            return;
          }
          request.write(init.body);
        }
        request.end();
      },
    );
    if (options.store) {
      let amount: number | null = ["firecrawl", "image"].includes(kind) ? null : 0;
      let source = "not_applicable";
      if (kind === "image") {
        try {
          const payload = JSON.parse(response.body.toString());
          if (payload.usage) {
            amount = imageCost(payload.usage);
            source = "estimated";
          }
        } catch {}
      }
      settle(options.store.db, reservation, { amount, source });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect_missing_location");
      const next = new URL(location, pinned.url);
      const headers = new Headers(init.headers);
      if (next.origin !== pinned.url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      const get =
        response.status === 303 || ([301, 302].includes(response.status) && init.method === "POST");
      return publicFetch(
        next.toString(),
        { ...init, headers, ...(get ? { method: "GET", body: undefined } : {}) },
        maxBytes,
        options,
        hops + 1,
      );
    }
    const result = new Response([204, 304].includes(response.status) ? null : response.body, {
      status: response.status,
      headers: response.headers,
    });
    Object.defineProperty(result, "url", { value: pinned.url.toString() });
    return result;
  } catch (error) {
    if (options.store) settle(options.store.db, reservation, { status: "unknown" });
    throw error;
  }
}

export function liveHttp(
  log?: Logger,
  optionsConfig: { store?: Store; allowPrivateForTests?: boolean } = {},
): Http {
  const run = async (url: string, init: RequestInit, options: GetOptions): Promise<HttpResponse> =>
    withRetry(
      async () => {
        const res = await publicFetch(
          url,
          {
            ...init,
            redirect: "follow",
            signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
          },
          Math.min(options.maxBytes ?? 1024 * 1024, 1024 * 1024),
          optionsConfig,
        );
        if (!res.ok && !(options.allowStatus ?? []).includes(res.status)) {
          const body = (await readCapped(res, 4000)).slice(0, 500);
          throw new HttpError(res.status, `GET ${new URL(url).host} HTTP ${res.status}`, {
            retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
            body,
          });
        }
        return {
          status: res.status,
          url: res.url || url,
          headers: res.headers,
          text: await readCapped(res, options.maxBytes ?? 1024 * 1024),
        };
      },
      {
        attempts: 3,
        retryOn: (error) =>
          !(error instanceof BudgetExceeded) &&
          !(error instanceof UnsafeUrl) &&
          !String(error).includes("body_limit") &&
          isRetryable(error) &&
          !(error instanceof HttpError && options.noRetryOn?.includes(error.status)),
        baseMs: 800,
        maxMs: 8000,
        onRetry: (i) =>
          log?.warn("http.retry", {
            url,
            attempt: i.attempt,
            delayMs: i.delayMs,
            error: String(i.error),
          }),
      },
    );
  return {
    get: (url, options = {}) =>
      run(
        url,
        { headers: { "user-agent": USER_AGENT, accept: "*/*", ...options.headers } },
        options,
      ),
    postJson: (url, body, headers, options = {}) =>
      run(
        url,
        {
          method: "POST",
          headers: { "user-agent": USER_AGENT, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
        { timeoutMs: options.timeoutMs ?? 60_000 },
      ),
    postForm: (url, form, options = {}) =>
      run(
        url,
        {
          method: "POST",
          headers: {
            "user-agent": USER_AGENT,
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            ...options.headers,
          },
          body: form,
        },
        options,
      ),
  };
}

/** Plain text from HTML snippets (feed descriptions). */
export function stripHtml(html: string | undefined, max = 600): string | undefined {
  if (!html) return undefined;
  const text = decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}` : text || undefined;
}

export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "\u2026",
    mdash: "\u2014",
    ndash: "\u2013",
    rsquo: "'",
    lsquo: "'",
    ldquo: '"',
    rdquo: '"',
  };
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}
