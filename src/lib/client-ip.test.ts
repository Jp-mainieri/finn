import { describe, expect, it } from "vitest";
import { getClientIp } from "./client-ip";

const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });

describe("getClientIp", () => {
  it.each([
    [{ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, "1.2.3.4"],
    [{ "x-vercel-forwarded-for": "1.2.3.4, 5.6.7.8" }, "1.2.3.4"],
    [{ "x-forwarded-for": "1.2.3.4:5555" }, "1.2.3.4"],
    [{ "x-forwarded-for": "[2001:db8::1]:443" }, "2001:db8::1"],
    [{ "x-forwarded-for": "[2001:db8::1]" }, "2001:db8::1"],
    [{ "x-forwarded-for": "2001:db8::1" }, "2001:db8::1"],
    [{ "x-forwarded-for": "junk, 9.9.9.9" }, "9.9.9.9"],
    [{ "x-forwarded-for": "junk" }, null],
    [{ "x-forwarded-for": "999.1.1.1" }, null],
    [{ "x-forwarded-for": "1.2.3.4:99999999" }, null],
    [{ "x-forwarded-for": "2001:db8::1:443" }, "2001:db8::1:443"], // a valid bare IPv6, not host:port
    [{}, null],
    [{ "x-forwarded-for": " , " }, null],
  ])("%j -> %j", (h, want) => {
    expect(getClientIp(req(h))).toBe(want);
  });

  it("precedence: x-vercel-forwarded-for, then x-real-ip, then x-forwarded-for; invalid falls through", () => {
    const all = { "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" };
    expect(getClientIp(req(all))).toBe("1.1.1.1");
    expect(getClientIp(req({ ...all, "x-vercel-forwarded-for": "junk" }))).toBe("2.2.2.2");
    expect(getClientIp(req({ ...all, "x-vercel-forwarded-for": "junk", "x-real-ip": "junk" }))).toBe("3.3.3.3");
  });
});
