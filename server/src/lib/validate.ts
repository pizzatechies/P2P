import { z } from "zod";
import { badRequest } from "./errors.js";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join(".");
    throw badRequest(
      field ? `${field}: ${first.message}` : (first?.message ?? "Invalid request"),
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export const amountField = z.union([z.string(), z.number()]).transform((v) => String(v));
export const currencyField = z
  .string()
  .length(3)
  .transform((v) => v.toUpperCase());
export const idempotencyField = z.string().min(8).max(100).optional();
