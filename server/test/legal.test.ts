import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

describe("legal pages", () => {
  it("serves company details for the legal pages, and limits per level for the fees page", async () => {
    const blank = await request(makeApp().app).get("/api/public/legal");
    expect(blank.body).toMatchObject({ final: false, company: { name: null }, contact: { supportEmail: null, complaintsEmail: null } });

    const { app } = makeApp({ LEGAL_COMPANY_NAME: "Pizza Techies Ltd", LEGAL_COUNTRY: "Kenya", SUPPORT_EMAIL: "help@aurex.example", LEGAL_FINAL: "true", LEGAL_EFFECTIVE_DATE: "2027-01-15", KYC_LIMITS: "true", MERCHANT_FEE_BPS: "150" });
    const legal = (await request(app).get("/api/public/legal")).body;
    // Complaints go to support unless a separate address is set.
    expect(legal).toMatchObject({ final: true, effectiveDate: "2027-01-15", company: { name: "Pizza Techies Ltd", country: "Kenya" }, contact: { supportEmail: "help@aurex.example", complaintsEmail: "help@aurex.example" } });

    const meta = (await request(app).get("/api/meta")).body;
    expect(meta.fees.merchantBps).toBe(150);
    expect(meta.limits.byLevel).toEqual([
      { level: 0, txUsd: 200, dailyUsd: 500 },
      { level: 1, txUsd: 2000, dailyUsd: 5000 },
      { level: 2, txUsd: 10000, dailyUsd: 25000 },
    ]);
    expect(meta.limits.payoutReviewUsd).toBeNull(); // PAYOUT_REVIEW is off in the test defaults
  });
});
