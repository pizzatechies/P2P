import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, decryptSecret, encryptSecret, hashPassword, totp, verifyPassword, verifyTotp } from "../src/lib/crypto.js";
import { bps, fromMinor, toMinor } from "../src/lib/money.js";
import { extractJson } from "../src/services/ai/gateway.js";
import { convertMinor } from "../src/services/fx.js";
import { rsi, sma, summarize } from "../src/services/trading/indicators.js";
import { simulatedMarket } from "../src/services/trading/market.js";
import { ruleBasedSignal } from "../src/services/trading/analyst.js";

describe("money", () => {
  it("parses decimal strings to minor units without float error", () => {
    expect(toMinor("0.1", "USD")).toBe(10);
    expect(toMinor("19.99", "USD")).toBe(1999);
    expect(toMinor("1000", "JPY")).toBe(1000);
    expect(toMinor(12.5, "EUR")).toBe(1250);
  });
  it("rejects bad amounts", () => {
    expect(() => toMinor("-5", "USD")).toThrow();
    expect(() => toMinor("1.234", "USD")).toThrow(/decimal/);
    expect(() => toMinor("1.5", "JPY")).toThrow();
    expect(() => toMinor("abc", "USD")).toThrow();
    expect(() => toMinor("5", "XXX")).toThrow(/Unsupported/);
  });
  it("formats minor units", () => {
    expect(fromMinor(1999, "USD")).toBe("19.99");
    expect(fromMinor(5, "USD")).toBe("0.05");
    expect(fromMinor(-150, "EUR")).toBe("-1.50");
    expect(fromMinor(1500, "JPY")).toBe("1500");
  });
  it("computes basis-point fees and FX conversions", () => {
    expect(bps(10000, 50)).toBe(50);
    expect(bps(999, 0)).toBe(0);
    expect(convertMinor(10000, "USD", "JPY", 150)).toBe(15000); // $100 -> ¥15,000
    expect(convertMinor(15000, "JPY", "USD", 1 / 150)).toBe(10000);
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("s3cret-password");
    expect(await verifyPassword("s3cret-password", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("encrypts secrets with authentication", () => {
    const key = Buffer.alloc(32, 7);
    const enc = encryptSecret("sk-live-abc", key);
    expect(enc).not.toContain("sk-live");
    expect(decryptSecret(enc, key)).toBe("sk-live-abc");
    expect(() => decryptSecret(enc, Buffer.alloc(32, 8))).toThrow();
  });
  it("implements RFC 6238 TOTP", () => {
    // RFC 6238 test vector: secret "12345678901234567890", T=59s -> 94287082 (8 digits) -> last 6: 287082
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totp(secret, 59_000)).toBe("287082");
    expect(verifyTotp(secret, totp(secret, Date.now()))).toBe(true);
    expect(verifyTotp(secret, "000000", 59_000)).toBe(false);
  });
});

describe("AI helpers", () => {
  it("extracts JSON from model replies", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"action":"hold"} hope that helps')).toEqual({ action: "hold" });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("indicators & simulated market", () => {
  it("computes SMA and RSI", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1))).toBe(100);
  });
  it("produces deterministic simulated prices and sane indicators", async () => {
    const a = await simulatedMarket.bars("AAPL", 260);
    const b = await simulatedMarket.bars("AAPL", 260);
    expect(a).toEqual(b);
    expect(a.length).toBe(260);
    for (const bar of a) expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c) - 0.01);
    const q = await simulatedMarket.quote("AAPL");
    expect(q.price).toBeGreaterThan(0);
    const ind = summarize(a, q.price);
    expect(ind.rsi14).toBeGreaterThanOrEqual(0);
    expect(ind.rsi14).toBeLessThanOrEqual(100);
    const sig = ruleBasedSignal(ind);
    expect(["buy", "sell", "hold"]).toContain(sig.action);
    expect(sig.confidence).toBeLessThanOrEqual(1);
  });
});
