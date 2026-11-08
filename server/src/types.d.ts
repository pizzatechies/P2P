import type { AuthUser } from "./services/users.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
      rawBody?: Buffer;
    }
  }
}

export {};
