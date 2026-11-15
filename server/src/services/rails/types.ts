export interface DepositInput {
  externalId: string;
  userId: string;
  email: string;
  currency: string;
  amount: number; // minor units
  /** Phone number for push-to-phone rails (M-Pesa STK Push, MTN MoMo). */
  phone?: string;
}

export interface DepositResult {
  status: "completed" | "pending";
  providerRef?: string;
  /** Where to send the user to finish paying (hosted checkout), if the rail needs it. */
  redirectUrl?: string;
  /** What the user should do next when there's no page to visit, e.g. "Approve the payment on your phone". */
  instructions?: string;
}

export interface PayoutDestination {
  type: "bank_account" | "mobile_money" | "card" | "email" | "wise";
  name: string;
  /** Bank account or mobile-money number. */
  accountNumber?: string;
  bankCode?: string;
  country?: string;
  /** PayPal/Venmo receiver: an email address or phone number. */
  email?: string;
  wallet?: "paypal" | "venmo";
  /** Wise recipient type (e.g. "iban", "sort_code") and its details, keyed as in Wise's requirements ("address.city"). */
  wiseType?: string;
  details?: Record<string, string>;
}

/** A payout form described by the provider (Wise account requirements), rendered generically by the web app. */
export interface RequirementField {
  key: string;
  name: string;
  type: string;
  required: boolean;
  refreshRequirementsOnChange: boolean;
  example?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  validationRegexp?: string | null;
  valuesAllowed?: { key: string; name: string }[] | null;
}

export interface RequirementGroup {
  type: string;
  title: string;
  fields: { name: string; group: RequirementField[] }[];
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
 * A way money enters or leaves the platform. Add a new rail by implementing this interface and
 * registering it in rails/index.ts. The ledger and the rest of the app don't need to change.
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
  /** What the deposit form must collect: nothing (hosted checkout) or the payer's phone number. */
  depositInput?: "none" | "phone";
  /** What the withdraw form must collect. "requirements" means a provider-described form (payoutRequirements). */
  payoutInput?: "bank" | "bank_code" | "phone" | "email" | "requirements";
  /** Example phone format for phone inputs. */
  phoneHint?: string;
  createDeposit?(input: DepositInput): Promise<DepositResult>;
  createPayout?(input: PayoutInput): Promise<PayoutResult>;
  /** Asks the provider for the real state of a pending deposit (never trust a redirect or webhook alone). */
  checkDeposit?(input: { externalId: string; providerRef: string | null; currency: string; amount: number }): Promise<"completed" | "pending" | "failed">;
  /** Asks the provider for the real state of a pending payout. */
  checkPayout?(input: { externalId: string; providerRef: string | null }): Promise<"completed" | "pending" | "failed">;
  /** Fields the provider needs for a payout to this currency (and, after a change, the refreshed fields). */
  payoutRequirements?(input: {
    currency: string;
    amount: number;
    quoteId?: string;
    type?: string;
    details?: Record<string, string>;
  }): Promise<{ quoteId: string; groups: RequirementGroup[] }>;
}
