import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export class UnsafeUrl extends Error {}
export function publicAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(value) === 6) {
    if (value.startsWith("::ffff:")) {
      const tail = value.slice(7);
      if (isIP(tail) === 4) return publicAddress(tail);
      const pieces = tail.split(":");
      if (pieces.length === 2) {
        const hi = parseInt(pieces[0], 16),
          lo = parseInt(pieces[1], 16);
        return publicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
      return false;
    }
    return (
      /^[23]/.test(value) &&
      !value.startsWith("2001:db8:") &&
      !value.startsWith("2001:0:") &&
      !value.startsWith("2002:")
    );
  }
  return false;
}
export function checkedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrl("Invalid source URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) && !publicAddress(host))
  )
    throw new UnsafeUrl("Local/private or credentialed source URL blocked");
  return url;
}
export async function resolvePublic(
  input: string,
  resolve: (
    hostname: string,
    options: { all: true },
  ) => Promise<{ address: string; family: number }[]> = lookup,
  signal?: AbortSignal,
): Promise<{ url: URL; address: string; family: number }> {
  const url = checkedUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  signal?.throwIfAborted();
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<{ address: string; family: number }[]>((done, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("DNS lookup aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        resolve(host, { all: true })
          .then(done, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new UnsafeUrl("DNS resolves to a private or reserved address");
  return { url, ...addresses[0] };
}
