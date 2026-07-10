/**
 * SSRF guard for outbound built-in webhook integrations (currently the
 * Feishu/Lark custom-bot notifier). The server POSTs to a user-supplied URL, so
 * without this an authenticated team member (or, in open mode, an unauthenticated
 * caller) could turn a "Feishu" channel into a blind server-side POST/scan
 * primitive against loopback, RFC1918, link-local, or cloud-metadata endpoints.
 *
 * Two independent layers, both enforced at create/test AND send time:
 *   1. DESTINATION ALLOWLIST — a built-in integration only ever legitimately
 *      talks to Feishu/Lark. We pin `https:` + an exact host allowlist + the
 *      official bot-webhook path shape. This alone closes the SSRF: an
 *      attacker-controlled host never passes.
 *   2. RESOLVED-IP GUARD (defense in depth) — even for an allowlisted host we
 *      resolve DNS and reject if ANY resolved address is non-public
 *      (loopback / private / link-local incl. 169.254.169.254 / ULA / multicast
 *      / reserved). Redirects are NOT auto-followed; each hop is re-validated
 *      against the same rules, so a 30x can't bounce the request onto an
 *      internal target.
 *
 * The pure pieces (`validateFeishuWebhookUrl`, `classifyAddress`) are exported
 * for isolated unit testing; `safeWebhookFetch` composes them with a bounded
 * timeout + bounded response read. DNS lookup + fetch are injectable seams so
 * tests never hit the network.
 *
 * Residual risk note: Node's global `fetch` re-resolves DNS on connect, so a
 * rebind between our validation and the actual connect is not fully closed by
 * stdlib alone (pinning the socket to the validated IP needs a custom dispatcher
 * we deliberately avoid pulling in). The exact-host allowlist bounds this to a
 * rebind of an official Feishu/Lark domain, and every redirect hop is
 * re-resolved + re-validated.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Official Feishu/Lark custom-bot webhook hosts (exact match, lowercased). */
export const FEISHU_WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
  "open.feishu.cn", // Feishu (China)
  "open.larksuite.com", // Lark (international)
  "open.larkoffice.com", // Lark (international, newer domain)
]);

/** The custom-bot incoming-webhook path shape: /open-apis/bot/v2/hook/<token>. */
export const FEISHU_WEBHOOK_PATH_PREFIX = "/open-apis/bot/v2/hook/";

/** Bounded-transport defaults for an outbound webhook POST. */
export const WEBHOOK_TIMEOUT_MS = 8000;
export const WEBHOOK_MAX_BYTES = 64 * 1024; // 64KB — webhook acks are tiny JSON
export const WEBHOOK_MAX_REDIRECTS = 3;

/** Result of validating a webhook URL string against the allowlist. */
export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Pure allowlist check: require `https:`, an exact Feishu/Lark host, and the
 * official bot-webhook path prefix. No DNS, no network — safe to call at create
 * time. Rejects userinfo (`user:pass@`) and any non-standard port.
 */
export function validateFeishuWebhookUrl(raw: string | undefined | null): UrlCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "missing webhook url" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "webhook url is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "webhook url must use https" };
  if (url.username || url.password) return { ok: false, error: "webhook url must not embed credentials" };
  const host = url.hostname.toLowerCase();
  if (!FEISHU_WEBHOOK_HOSTS.has(host)) {
    return { ok: false, error: `webhook host not allowed (must be a Feishu/Lark webhook host: ${[...FEISHU_WEBHOOK_HOSTS].join(", ")})` };
  }
  // Only the default https port; a non-443 port on an allowed host is suspicious.
  if (url.port && url.port !== "443") return { ok: false, error: "webhook url must use the default https port" };
  if (!url.pathname.startsWith(FEISHU_WEBHOOK_PATH_PREFIX)) {
    return { ok: false, error: `webhook path must start with ${FEISHU_WEBHOOK_PATH_PREFIX}` };
  }
  return { ok: true, url };
}

/** Parse a dotted-quad IPv4 string into a 32-bit unsigned int, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** True when a canonical IPv4 string is loopback/private/link-local/etc. */
function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable ⇒ fail closed
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network / unspecified
    inRange("10.0.0.0", 8) || // RFC1918
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // RFC1918
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.168.0.0", 16) || // RFC1918
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved / broadcast (255.255.255.255)
  );
}

/** Expand an IPv6 string to its 8 16-bit hextet words, or null if malformed. */
function ipv6Words(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf("%"); // strip scope id (fe80::1%eth0)
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) → convert to two hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.slice(lastColon + 1).includes(".")) {
    const v4 = s.slice(lastColon + 1);
    const n = ipv4ToInt(v4);
    if (n === null) return null;
    s = s.slice(0, lastColon + 1) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const parseGroup = (g: string): number | null => {
    if (g === "") return null;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    return parseInt(g, 16);
  };
  const words: number[] = [];
  for (const g of head) {
    const v = parseGroup(g);
    if (v === null) return null;
    words.push(v);
  }
  if (tail === null) {
    return words.length === 8 ? words : null;
  }
  const tailWords: number[] = [];
  for (const g of tail) {
    const v = parseGroup(g);
    if (v === null) return null;
    tailWords.push(v);
  }
  const fill = 8 - words.length - tailWords.length;
  if (fill < 0) return null;
  return [...words, ...Array(fill).fill(0), ...tailWords];
}

/** True when a canonical IPv6 string is non-public (loopback/ULA/link-local/…). */
function isBlockedIPv6(ip: string): boolean {
  const w = ipv6Words(ip);
  if (w === null || w.length !== 8) return true; // fail closed
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [number, number, number, number, number, number, number, number];
  if (w.every((x) => x === 0)) return true; // :: unspecified
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return true; // ::1 loopback
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:0:0/96) — classify the embedded v4.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return isBlockedIPv4(`${(w6 >>> 8) & 0xff}.${w6 & 0xff}.${(w7 >>> 8) & 0xff}.${w7 & 0xff}`);
  }
  return false;
}

/**
 * Classify a resolved IP address. Returns `null` when the address is a routable
 * public unicast address, or a short reason string when it must be blocked.
 * Fail-closed: anything unrecognized is blocked.
 */
export function classifyAddress(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIPv4(ip) ? "resolves to a non-public IPv4 address" : null;
  if (fam === 6) return isBlockedIPv6(ip) ? "resolves to a non-public IPv6 address" : null;
  return "unresolvable address"; // not a valid literal IP ⇒ fail closed
}

/** Injectable seams for `safeWebhookFetch` (tests never hit the network). */
export interface WebhookFetchDeps {
  /** Resolve a hostname to all A/AAAA addresses. */
  lookup?: (hostname: string) => Promise<{ address: string }[]>;
  /** The fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const defaultLookup = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `hostname` and reject if ANY resolved address is non-public. Throws an
 * Error whose message is safe to surface. Returns the validated addresses.
 */
export async function assertPublicHost(
  hostname: string,
  lookup: (h: string) => Promise<{ address: string }[]> = defaultLookup,
): Promise<string[]> {
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname);
  } catch {
    throw new Error(`could not resolve webhook host ${hostname}`);
  }
  if (!addrs.length) throw new Error(`webhook host ${hostname} did not resolve`);
  for (const { address } of addrs) {
    const reason = classifyAddress(address);
    if (reason) throw new Error(`webhook host ${hostname} ${reason} (${address})`);
  }
  return addrs.map((a) => a.address);
}

/** Read a Response body bounded to `maxBytes`; throws if the body overflows. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("webhook response exceeded size cap");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** The bounded, validated result of a webhook POST (body already read + parsed). */
export interface WebhookResponse {
  status: number;
  json: Record<string, unknown>;
}

/**
 * Validate the URL against the Feishu/Lark allowlist, resolve + IP-guard the
 * host, then POST with a bounded timeout + bounded response read. Redirects are
 * NOT auto-followed: a 30x is manually followed at most `maxRedirects` times,
 * re-running the FULL allowlist + IP guard on every hop, so a redirect can never
 * bounce the request onto an internal target. Rejects (throws) on any violation.
 */
export async function safeWebhookFetch(
  rawUrl: string,
  init: { body: string; headers: Record<string, string> },
  deps: WebhookFetchDeps = {},
): Promise<WebhookResponse> {
  const lookup = deps.lookup ?? defaultLookup;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? WEBHOOK_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? WEBHOOK_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = validateFeishuWebhookUrl(currentUrl);
    if (!check.ok) throw new Error(check.error);
    await assertPublicHost(check.url.hostname, lookup);

    const res = await fetchImpl(check.url.toString(), {
      method: "POST",
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    // A manual-redirect response: re-validate the target and follow it ourselves.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new Error("webhook redirect had no location");
      currentUrl = new URL(loc, check.url).toString();
      continue;
    }

    const text = await readBounded(res, maxBytes);
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }
    return { status: res.status, json };
  }
  throw new Error(`webhook exceeded ${maxRedirects} redirects`);
}
