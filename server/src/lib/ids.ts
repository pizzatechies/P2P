import { randomUUID } from "node:crypto";

/** Prefixed, sortable-enough ids that make logs and support tickets readable: e.g. txn_3f1c... */
export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
