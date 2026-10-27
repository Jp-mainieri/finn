import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, getTokenEncKey } from "./token-crypto";
import { OTHER_TEST_KEY, TEST_ENC_KEY } from "./testing";

const KEY = Buffer.from(TEST_ENC_KEY, "hex");
const AAD = "finn:preview:spotify:drv_" + "A".repeat(22);
const RT = "AQDxample-refresh_token.with-odd_chars";

function tamper(blob: string, index: 1 | 2 | 3): string {
  const parts = blob.split(".");
  const buf = Buffer.from(parts[index], "base64url");
  buf[0] ^= 0x01;
  parts[index] = buf.toString("base64url");
  return parts.join(".");
}

describe("token cipher (AES-256-GCM)", () => {
  it("round trips and has the v1.<iv>.<ct>.<tag> shape without the plaintext", () => {
    const blob = encryptToken(RT, KEY, AAD);
    expect(blob).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(blob).not.toContain(RT);
    expect(decryptToken(blob, KEY, AAD)).toBe(RT);
  });

  it("a different IV on every write", () => {
    const blobs = new Set(Array.from({ length: 50 }, () => encryptToken(RT, KEY, AAD)));
    expect(blobs.size).toBe(50);
    expect(new Set([...blobs].map((b) => b.split(".")[1])).size).toBe(50);
  });

  it.each<[string, 1 | 2 | 3]>([["iv", 1], ["ciphertext", 2], ["tag", 3]])("a tampered %s fails", (_name, i) => {
    const blob = encryptToken(RT, KEY, AAD);
    expect(decryptToken(tamper(blob, i), KEY, AAD)).toBeNull();
  });

  it("AAD of another driver or another environment fails", () => {
    const blob = encryptToken(RT, KEY, AAD);
    expect(decryptToken(blob, KEY, "finn:preview:spotify:drv_" + "B".repeat(22))).toBeNull();
    expect(decryptToken(blob, KEY, AAD.replace("preview", "production"))).toBeNull();
  });

  it("the wrong key fails", () => {
    const blob = encryptToken(RT, KEY, AAD);
    expect(decryptToken(blob, Buffer.from(OTHER_TEST_KEY, "hex"), AAD)).toBeNull();
    expect(decryptToken(blob, randomBytes(32), AAD)).toBeNull();
  });

  it("malformed blobs are null, never an exception", () => {
    const good = encryptToken(RT, KEY, AAD);
    const [v, iv, ct, tag] = good.split(".");
    for (const bad of [
      "", "x", RT, `${v}.${iv}.${ct}`, `${v}.${iv}.${ct}.${tag}.extra`, `v2.${iv}.${ct}.${tag}`,
      `${v}.${iv.slice(2)}.${ct}.${tag}`, `${v}.${iv}.${ct}.${tag.slice(2)}`, `${v}.${iv}..${tag}`,
      `${v}.${iv}.${ct}+.${tag}`, null, undefined, 42, {}, "v1." + "A".repeat(5000),
    ]) {
      expect(decryptToken(bad, KEY, AAD)).toBeNull();
    }
  });

  it("encrypt rejects a key that is not 32 bytes", () => {
    expect(() => encryptToken(RT, randomBytes(16), AAD)).toThrow();
  });
});

describe("getTokenEncKey (fail closed)", () => {
  const base = { FINN_TOKEN_ENC_KEY: TEST_ENC_KEY };
  it("accepts a valid key and returns 32 bytes", () => {
    expect(getTokenEncKey(base)?.length).toBe(32);
  });
  it("missing, empty, short, non-hex, weak: null", () => {
    for (const v of [undefined, "", "  ", "abc", "z".repeat(64), "a".repeat(64), "ab".repeat(33), TEST_ENC_KEY + "0"]) {
      expect(getTokenEncKey({ FINN_TOKEN_ENC_KEY: v })).toBeNull();
    }
  });
  it("equal to another secret (any case) is rejected", () => {
    for (const name of ["FINN_SESSION_SECRET", "FINN_INVITE_PEPPER", "FINN_A2A_TOKEN", "FINN_A2A_TOKEN_NEXT", "FINN_API_TOKEN"]) {
      expect(getTokenEncKey({ ...base, [name]: TEST_ENC_KEY })).toBeNull();
      expect(getTokenEncKey({ ...base, [name]: TEST_ENC_KEY.toUpperCase() })).toBeNull();
      expect(getTokenEncKey({ ...base, [name]: OTHER_TEST_KEY })).not.toBeNull();
    }
  });
});
