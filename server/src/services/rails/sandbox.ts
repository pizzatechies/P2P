import type { PaymentRail } from "./types.js";

/**
 * Simulated rail for development and demos: deposits succeed instantly and payouts settle
 * immediately. Withdrawals to an account number ending in "0000" fail, so the reversal path can
 * be exercised. Never enable this in a production deployment that holds real customer funds.
 */
export const sandboxRail: PaymentRail = {
  id: "sandbox",
  name: "Sandbox (test money)",
  description: "Instant simulated deposits and payouts. No real money moves.",
  simulated: true,
  supportsDeposit: true,
  supportsWithdrawal: true,
  currencies: "*",
  async createDeposit(input) {
    return { status: "completed", providerRef: `sbx_dep_${input.externalId}` };
  },
  async createPayout(input) {
    if (input.destination.accountNumber.endsWith("0000")) {
      return { status: "failed", failureReason: "Sandbox: destination account rejected the payout" };
    }
    return { status: "completed", providerRef: `sbx_pay_${input.externalId}` };
  },
};
