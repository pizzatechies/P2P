import type { AuthUser } from "./services/users.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
      /** When this session last passed a password (and 2FA) check. */
      reauthAt?: string | null;
      rawBody?: Buffer;
    }
  }
}

export {};
