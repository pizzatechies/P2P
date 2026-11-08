import type { Ctx } from "../../context.js";
import { badRequest } from "../../lib/errors.js";
import { sandboxRail } from "./sandbox.js";
import { stripeRail } from "./stripe.js";
import type { PaymentRail } from "./types.js";

export type { PaymentRail } from "./types.js";

const registries = new WeakMap<Ctx["config"], Map<string, PaymentRail>>();

export function getRails(ctx: Ctx): Map<string, PaymentRail> {
  let rails = registries.get(ctx.config);
  if (rails) return rails;
  rails = new Map();
  for (const id of ctx.config.rails) {
    if (id === "sandbox") rails.set(id, sandboxRail);
    else if (id === "stripe" && ctx.config.STRIPE_SECRET_KEY) {
      rails.set(id, stripeRail({ secretKey: ctx.config.STRIPE_SECRET_KEY, appUrl: ctx.config.APP_URL }));
    } else console.warn(`[rails] unknown or unconfigured payment rail "${id}" ignored`);
  }
  registries.set(ctx.config, rails);
  return rails;
}

export function getRail(ctx: Ctx, id: string, purpose: "deposit" | "withdrawal", currency: string): PaymentRail {
  const rail = getRails(ctx).get(id);
  if (!rail) throw badRequest(`Payment method "${id}" is not available`);
  if (purpose === "deposit" && !rail.supportsDeposit) throw badRequest(`${rail.name} can't be used to add money`);
  if (purpose === "withdrawal" && !rail.supportsWithdrawal) throw badRequest(`${rail.name} can't be used to withdraw`);
  if (rail.currencies !== "*" && !rail.currencies.includes(currency)) {
    throw badRequest(`${rail.name} doesn't support ${currency}`);
  }
  return rail;
}

export function describeRails(ctx: Ctx) {
  return [...getRails(ctx).values()].map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    simulated: r.simulated,
    supportsDeposit: r.supportsDeposit,
    supportsWithdrawal: r.supportsWithdrawal,
    currencies: r.currencies,
  }));
}
