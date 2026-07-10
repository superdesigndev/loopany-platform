import { describe, expect, test } from "vitest";
import {
  assertPublicHost,
  classifyAddress,
  safeWebhookFetch,
  validateFeishuWebhookUrl,
} from "./webhookGuard";

const OK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/abc123";
const OK_LARK = "https://open.larksuite.com/open-apis/bot/v2/hook/xyz";

describe("validateFeishuWebhookUrl — destination allowlist (create/test time)", () => {
  test("accepts an official Feishu/Lark HTTPS webhook URL", () => {
    expect(validateFeishuWebhookUrl(OK_URL)).toMatchObject({ ok: true });
    expect(validateFeishuWebhookUrl(OK_LARK)).toMatchObject({ ok: true });
    expect(validateFeishuWebhookUrl("https://open.larkoffice.com/open-apis/bot/v2/hook/t")).toMatchObject({ ok: true });
  });

  test("rejects a non-HTTPS scheme", () => {
    for (const u of [
      "http://open.feishu.cn/open-apis/bot/v2/hook/x",
      "http://127.0.0.1/open-apis/bot/v2/hook/x",
      "file:///etc/passwd",
      "gopher://open.feishu.cn/",
    ]) {
      const r = validateFeishuWebhookUrl(u);
      expect(r.ok).toBe(false);
    }
  });

  test("rejects a non-allowlisted host even over HTTPS", () => {
    for (const u of [
      "https://127.0.0.1/open-apis/bot/v2/hook/x",
      "https://169.254.169.254/open-apis/bot/v2/hook/x",
      "https://evil.example.com/open-apis/bot/v2/hook/x",
      "https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/x",
      "https://internal/open-apis/bot/v2/hook/x",
    ]) {
      expect(validateFeishuWebhookUrl(u).ok).toBe(false);
    }
  });

  test("rejects embedded credentials, a non-443 port, or a wrong path shape", () => {
    expect(validateFeishuWebhookUrl("https://user:pass@open.feishu.cn/open-apis/bot/v2/hook/x").ok).toBe(false);
    expect(validateFeishuWebhookUrl("https://open.feishu.cn:8443/open-apis/bot/v2/hook/x").ok).toBe(false);
    expect(validateFeishuWebhookUrl("https://open.feishu.cn/evil/path").ok).toBe(false);
    expect(validateFeishuWebhookUrl("https://open.feishu.cn/").ok).toBe(false);
  });

  test("rejects empty / malformed input", () => {
    expect(validateFeishuWebhookUrl("").ok).toBe(false);
    expect(validateFeishuWebhookUrl(null).ok).toBe(false);
    expect(validateFeishuWebhookUrl("not a url").ok).toBe(false);
  });
});

describe("classifyAddress — IP classification (SSRF guard)", () => {
  test("blocks loopback / private / link-local / metadata IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.0.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1", // multicast
    ]) {
      expect(classifyAddress(ip), ip).not.toBeNull();
    }
  });

  test("allows a routable public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(classifyAddress(ip), ip).toBeNull();
    }
  });

  test("blocks loopback / ULA / link-local / mapped-private IPv6", () => {
    for (const ip of [
      "::1", // loopback
      "::", // unspecified
      "fc00::1", // ULA
      "fd12:3456::1", // ULA
      "fe80::1", // link-local
      "ff02::1", // multicast
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "::ffff:10.0.0.1", // IPv4-mapped private
    ]) {
      expect(classifyAddress(ip), ip).not.toBeNull();
    }
  });

  test("allows a routable public IPv6", () => {
    expect(classifyAddress("2001:4860:4860::8888")).toBeNull();
  });

  test("fails closed on non-IP input", () => {
    expect(classifyAddress("not-an-ip")).not.toBeNull();
  });
});

describe("assertPublicHost — DNS resolution guard", () => {
  const lookupTo = (...addrs: string[]) => async () => addrs.map((address) => ({ address }));

  test("rejects a host that resolves to loopback", async () => {
    await expect(assertPublicHost("open.feishu.cn", lookupTo("127.0.0.1"))).rejects.toThrow(/non-public/);
  });

  test("rejects when ANY resolved address is private (mixed answer)", async () => {
    await expect(assertPublicHost("open.feishu.cn", lookupTo("8.8.8.8", "10.0.0.1"))).rejects.toThrow(/non-public/);
  });

  test("accepts a host that resolves only to public addresses", async () => {
    await expect(assertPublicHost("open.feishu.cn", lookupTo("93.184.216.34"))).resolves.toEqual(["93.184.216.34"]);
  });

  test("rejects a host that does not resolve", async () => {
    await expect(assertPublicHost("open.feishu.cn", async () => [])).rejects.toThrow(/did not resolve|could not resolve/);
  });
});

describe("safeWebhookFetch — end-to-end guarded send", () => {
  const publicLookup = async () => [{ address: "93.184.216.34" }];
  const okBody = { headers: { "Content-Type": "application/json" }, body: "{}" };

  test("posts to an allowlisted host resolving public and returns the parsed body", async () => {
    let called = "";
    const res = await safeWebhookFetch(OK_URL, okBody, {
      lookup: publicLookup,
      fetchImpl: (async (url: string) => {
        called = url;
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(OK_URL);
    expect(res.json).toEqual({ code: 0 });
  });

  test("rejects an off-allowlist URL before any fetch", async () => {
    let fetched = false;
    await expect(
      safeWebhookFetch("https://evil.example.com/open-apis/bot/v2/hook/x", okBody, {
        lookup: publicLookup,
        fetchImpl: (async () => {
          fetched = true;
          return new Response("{}");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not allowed/);
    expect(fetched).toBe(false);
  });

  test("rejects when the allowlisted host resolves to a private address", async () => {
    await expect(
      safeWebhookFetch(OK_URL, okBody, {
        lookup: async () => [{ address: "169.254.169.254" }],
        fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/non-public/);
  });

  test("does NOT follow a redirect to a blocked target — re-validates and rejects", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.startsWith(OK_URL)) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      throw new Error("should not reach the redirect target");
    }) as unknown as typeof fetch;
    await expect(safeWebhookFetch(OK_URL, okBody, { lookup: publicLookup, fetchImpl })).rejects.toThrow(
      /https|not allowed/,
    );
  });

  test("follows an allowlisted redirect but still IP-guards it", async () => {
    const redirectTarget = OK_LARK;
    const fetchImpl = (async (url: string) => {
      if (url.startsWith(OK_URL)) {
        return new Response(null, { status: 302, headers: { location: redirectTarget } });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await safeWebhookFetch(OK_URL, okBody, { lookup: publicLookup, fetchImpl });
    expect(res.json).toEqual({ code: 0 });
  });

  test("bounds the response read and rejects an oversized body", async () => {
    const huge = "x".repeat(200 * 1024);
    await expect(
      safeWebhookFetch(OK_URL, okBody, {
        lookup: publicLookup,
        maxBytes: 1024,
        fetchImpl: (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/size cap/);
  });
});
