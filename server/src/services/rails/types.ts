export interface DepositInput {
  externalId: string;
  userId: string;
  email: string;
  currency: string;
  amount: number; // minor units
}

export interface DepositResult {
  status: "completed" | "pending";
  providerRef?: string;
  /** Where to send the user to finish paying (hosted checkout), if the rail needs it. */
  redirectUrl?: string;
}

export interface PayoutDestination {
  type: "bank_account" | "mobile_money" | "card";
  name: string;
  accountNumber: string;
  bankCode?: string;
  country?: string;
}

export interface PayoutInput {
  externalId: string;
  userId: string;
  currency: string;
  amount: number; // minor units
  destination: PayoutDestination;
}

export interface PayoutResult {
  status: "completed" | "pending" | "failed";
  providerRef?: string;
  failureReason?: string;
}

/**
 * A way money enters or leaves the platform. Add a new rail (bank transfer, mobile money such as
 * M-Pesa/MTN via an aggregator, card payouts, ...) by implementing this interface and registering
 * it in rails/index.ts. The ledger and the rest of the app don't need to change.
 */
export interface PaymentRail {
  id: string;
  name: string;
  description: string;
  /** True for rails that don't move real money. */
  simulated: boolean;
  supportsDeposit: boolean;
  supportsWithdrawal: boolean;
  /** Currencies the rail accepts, or "*" for any supported by the app. */
  currencies: string[] | "*";
  createDeposit?(input: DepositInput): Promise<DepositResult>;
  createPayout?(input: PayoutInput): Promise<PayoutResult>;
}
