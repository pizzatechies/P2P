import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Ctx } from "../../context.js";
import { HttpError } from "../../lib/errors.js";

/**
 * Bitnob's card-issuing API (https://bitnob.dev, "Card issuing"): prepaid virtual USD Visa and
 * Mastercard cards for customers in Africa. Unlike Stripe Issuing, a Bitnob card holds its own balance:
 * Aurex loads it from the customer's wallet and moves money back on request, and Bitnob's webhooks
 * report what was spent.
 *
 * - Requests are signed: HMAC-SHA256 of "{client id}:{timestamp}:{nonce}:{body}" with the client secret.
 * - Amounts are micro-units (1 USD = 1,000,000).
 * - Webhooks are signed with HMAC-SHA512 of the raw body (x-bitnob-signature), using the webhook secret.
 */

export const MICRO_PER_CENT = 10_000;
export const toMicro = (cents: number) => cents * MICRO_PER_CENT;
export const fromMicro = (micro: string | number | null | undefined) => Math.round(Number(micro ?? 0) / MICRO_PER_CENT);

export interface BitnobCard {
  id: string;
  status?: string;
  created_status?: string;
  card_brand?: string;
  last_four_digit?: string;
  masked_pan?: string;
  balance_amount?: string | number;
  balance_currency?: string;
  reference?: string;
}
export interface BitnobBalanceTx {
  id?: string;
  status?: string;
  amount?: string | number;
  fee_amount?: string | number;
  reference?: string;
}

async function call<T>(ctx: Ctx, method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<T> {
  const clientId = ctx.config.BITNOB_CLIENT_ID ?? "";
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", ctx.config.BITNOB_CLIENT_SECRET ?? "").update(`${clientId}:${timestamp}:${nonce}:${raw}`).digest("hex");
  let res: Response;
  try {
    res = await fetch(`${ctx.config.BITNOB_BASE_URL.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(raw ? { "Content-Type": "application/json" } : {}),
        "X-Auth-Client": clientId,
        "X-Auth-Timestamp": timestamp,
        "X-Auth-Nonce": nonce,
        "X-Auth-Signature": signature,
      },
      body: raw || undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new HttpError(502, "card_provider_error", `Couldn't reach the card issuer: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: unknown;
    message?: string;
    error?: { code?: string; message?: string };
    code?: string;
    detail?: string;
    title?: string;
  };
  if (!res.ok || json.success === false) {
    // Bitnob answers errors either in its own envelope or as an RFC 7807 problem.
    const message = json.error?.message ?? json.detail ?? json.title ?? json.message ?? `HTTP ${res.status}`;
    const code = json.error?.code ?? json.code ?? "card_provider_error";
    throw new HttpError(res.status >= 500 || res.status === 401 || res.status === 403 ? 502 : 422, "card_provider_error", `Card issuer: ${message}`, { providerCode: code });
  }
  return json.data as T;
}

export interface KycCustomer {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  idType: string;
  idNumber: string;
  email: string;
  phone: string;
  dialCode: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-3. */
  country: string;
}
export interface KycInput {
  customer: KycCustomer;
  occupation: string;
  employmentStatus: string;
  accountPurpose: string;
  annualSalary: string;
  expectedMonthlyVolume: string;
  idFrontImage?: string | null;
  idBackImage?: string | null;
}

/** Card KYC: Bitnob checks the cardholder. "approved" straight away for some ID types, otherwise within minutes (webhook). */
export function submitKyc(ctx: Ctx, input: KycInput, webhookUrl: string) {
  const c = input.customer;
  return call<{ customer_id: string; status?: string; normalized_status?: string; completion_link?: string | null; verification_link?: string | null }>(ctx, "POST", "/api/cards/kyc", {
    customer: {
      customer_type: "individual",
      first_name: c.firstName,
      last_name: c.lastName,
      date_of_birth: c.dateOfBirth,
      id_type: c.idType,
      id_number: c.idNumber,
      email: c.email,
      phone_number: c.phone,
      dial_code: c.dialCode,
      line1: c.line1,
      ...(c.line2 ? { line2: c.line2 } : {}),
      city: c.city,
      state: c.state,
      postal_code: c.postalCode,
      country: c.country,
    },
    occupation: input.occupation,
    employment_status: input.employmentStatus,
    account_purpose: input.accountPurpose,
    annual_salary: input.annualSalary,
    expected_monthly_volume: input.expectedMonthlyVolume,
    terms_of_service_accepted: true,
    card_program: "prepaid",
    webhook_url: webhookUrl,
    ...(input.idFrontImage ? { id_front_image: input.idFrontImage } : {}),
    ...(input.idBackImage ? { id_back_image: input.idBackImage } : {}),
  });
}

export async function createCard(ctx: Ctx, p: { customerId: string; amountCents: number; reference: string; name: string; webhookUrl: string }) {
  const data = await call<{ card?: BitnobCard } & BitnobCard>(ctx, "POST", "/api/cards", {
    card_type: "virtual",
    card_program: "prepaid",
    currency: "USD",
    card_brand: ctx.config.BITNOB_CARD_BRAND,
    amount: toMicro(p.amountCents),
    customer_id: p.customerId,
    reference: p.reference,
    name: p.name.slice(0, 100),
    contactless_payment: true,
    webhook_url: p.webhookUrl,
  });
  return data.card ?? data;
}

export async function getCard(ctx: Ctx, cardId: string) {
  const data = await call<{ card?: BitnobCard } & BitnobCard>(ctx, "GET", `/api/cards/${encodeURIComponent(cardId)}`);
  return data.card ?? data;
}

/** Loads money onto the card ("fund") or moves it back to the company balance ("withdraw"). */
export async function moveBalance(ctx: Ctx, cardId: string, type: "fund" | "withdraw", amountCents: number, reference: string) {
  const data = await call<{ success?: boolean; message?: string; transaction?: BitnobBalanceTx }>(ctx, "POST", `/api/cards/${encodeURIComponent(cardId)}/balance`, {
    type,
    amount: toMicro(amountCents),
    reference,
  });
  return data.transaction ?? {};
}

export const setStatus = (ctx: Ctx, cardId: string, status: "frozen" | "active") => call(ctx, "POST", `/api/cards/${encodeURIComponent(cardId)}/status`, { status });
export const terminate = (ctx: Ctx, cardId: string, reason: string) => call(ctx, "DELETE", `/api/cards/${encodeURIComponent(cardId)}`, { reason });

/** The card number for the cardholder's eyes only (Bitnob audits and rate-limits every reveal). */
export async function revealCard(ctx: Ctx, cardId: string) {
  const data = await call<{
    details?: { card_number?: string; cvv?: string; expiry_month?: string; expiry_year?: string };
    card_number?: string;
    cvv?: string;
    expiry_month?: string;
    expiry_year?: string;
    secure_view_url?: string | null;
  }>(ctx, "GET", `/api/cards/${encodeURIComponent(cardId)}/secure`);
  const d = data.details ?? data;
  return { number: d.card_number || null, cvc: d.cvv || null, expMonth: Number(d.expiry_month) || null, expYear: Number(d.expiry_year) || null, secureViewUrl: data.secure_view_url ?? null };
}

let occupationCache: { at: number; list: { code: string; description: string }[] } | null = null;
/** Bitnob's occupation codes for the card application (cached for a day). */
export async function occupations(ctx: Ctx) {
  if (occupationCache && Date.now() - occupationCache.at < 24 * 3600_000) return occupationCache.list;
  const data = await call<{ occupations?: { code: string; description: string }[] }>(ctx, "GET", "/api/cards/kyc/occupations");
  occupationCache = { at: Date.now(), list: data.occupations ?? [] };
  return occupationCache.list;
}
export const clearOccupationCache = () => {
  occupationCache = null;
};

/** x-bitnob-signature: hex HMAC-SHA512 of the raw request body, keyed with the webhook secret. */
export function verifyWebhook(raw: Buffer, header: string | undefined, secret: string) {
  if (!header) return false;
  const expected = createHmac("sha512", secret).update(raw).digest("hex");
  const given = header.trim().toLowerCase();
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Countries: Bitnob wants ISO alpha-3 codes, and the phone number split from its dialling code.
// ---------------------------------------------------------------------------
const COUNTRIES = `DZ DZA 213,AO AGO 244,BJ BEN 229,BW BWA 267,BF BFA 226,BI BDI 257,CV CPV 238,CM CMR 237,CF CAF 236,TD TCD 235,KM COM 269,
CG COG 242,CD COD 243,CI CIV 225,DJ DJI 253,EG EGY 20,GQ GNQ 240,ER ERI 291,SZ SWZ 268,ET ETH 251,GA GAB 241,GM GMB 220,GH GHA 233,
GN GIN 224,GW GNB 245,KE KEN 254,LS LSO 266,LR LBR 231,LY LBY 218,MG MDG 261,MW MWI 265,ML MLI 223,MR MRT 222,MU MUS 230,MA MAR 212,
MZ MOZ 258,NA NAM 264,NE NER 227,NG NGA 234,RW RWA 250,ST STP 239,SN SEN 221,SC SYC 248,SL SLE 232,SO SOM 252,ZA ZAF 27,SS SSD 211,
SD SDN 249,TZ TZA 255,TG TGO 228,TN TUN 216,UG UGA 256,ZM ZMB 260,ZW ZWE 263,US USA 1,CA CAN 1,GB GBR 44,IE IRL 353,FR FRA 33,
DE DEU 49,IT ITA 39,ES ESP 34,PT PRT 351,NL NLD 31,BE BEL 32,SE SWE 46,AE ARE 971,IN IND 91,CN CHN 86,AU AUS 61`;
const BY_ALPHA2 = new Map(
  COUNTRIES.split(",").map((e) => {
    const [a2, a3, dial] = e.trim().split(" ");
    return [a2, { alpha3: a3, dial }] as const;
  }),
);
export const countryInfo = (alpha2: string) => BY_ALPHA2.get(alpha2.toUpperCase()) ?? null;

/** "+254 712 345 678" (or "0712 345678" for a Kenyan customer) → { dialCode: "+254", phone: "712345678" }. */
export function splitPhone(phone: string, alpha2: string) {
  const info = countryInfo(alpha2);
  const digits = phone.replace(/[^\d]/g, "");
  if (!info) return null;
  if (phone.trim().startsWith("+") || digits.startsWith(info.dial)) {
    if (!digits.startsWith(info.dial)) return null;
    return { dialCode: `+${info.dial}`, phone: digits.slice(info.dial.length).replace(/^0+/, "") };
  }
  return { dialCode: `+${info.dial}`, phone: digits.replace(/^0+/, "") };
}

/** Aurex's ID types in Bitnob's names (a Ghanaian national ID is the Ghana Card). */
export function idTypeFor(idType: string, idCountry: string) {
  if (idType === "national_id" && idCountry.toUpperCase() === "GH") return "ghana_card";
  return idType; // passport, national_id and drivers_license have the same names
}
