import type { Config } from "./config.js";
import type { DB } from "./db/index.js";

/** Everything a service needs, passed explicitly so tests can build isolated instances. */
export interface Ctx {
  config: Config;
  db: DB;
}
