import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { badRequest } from "./errors.js";

/**
 * Bases of the most-used passwords. A password is refused when, ignoring case and trailing digits or
 * symbols, it's one of these (so "Password2024!" and "qwerty123456" are both refused).
 */
const COMMON = new Set(
  (
    "password passw0rd p@ssword p@ssw0rd qwerty qwertyuiop qwerty123 asdfgh asdfghjkl zxcvbnm abc abcdef abcdefg letmein welcome " +
    "admin administrator login master monkey dragon football baseball soccer basketball iloveyou sunshine princess shadow " +
    "superman batman trustno1 starwars whatever freedom secret changeme default access hello hellothere michael jennifer " +
    "charlie jordan hunter killer ranger thomas daniel computer internet google samsung apple iphone android summer winter " +
    "autumn spring flower lovely loveme lover cookie cheese pepper ginger chocolate banana orange purple blessed blessing " +
    "jesus jesuschrist godisgood christ heaven angel mother family money moneyy million billion bitcoin crypto aurex wallet " +
    "kenya nairobi lagos nigeria lusaka zambia accra ghana kampala uganda london newyork america mpesa paypal " +
    "123456 1234567 12345678 123456789 1234567890 0987654321 111111 000000 123123 654321 121212 112233 696969 abc123 " +
    "1q2w3e 1q2w3e4r 1q2w3e4r5t q1w2e3r4 zaq12wsx qazwsx qazwsxedc 1qaz2wsx passpass"
  ).split(/\s+/),
);

export interface PasswordContext {
  email?: string;
  handle?: string;
  displayName?: string;
}

/** Synchronous rules: length, variety, common passwords and personal details. Throws a 400 with the reason. */
export function checkPasswordRules(config: Config, password: string, who: PasswordContext = {}) {
  if (password.length < config.PASSWORD_MIN_LENGTH) throw badRequest(`Use at least ${config.PASSWORD_MIN_LENGTH} characters`);
  if (password.length > 200) throw badRequest("Use at most 200 characters");
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) throw badRequest("Include at least one letter and one number");
  if (new Set(password.toLowerCase()).size < 5) throw badRequest("Use a less repetitive password");

  const lower = password.toLowerCase();
  const base = lower.replace(/[\d\W_]+$/g, "").replace(/^[\d\W_]+/g, "");
  if (COMMON.has(lower) || COMMON.has(base) || /^(.)\1+$/.test(base) || isSequence(lower)) {
    throw badRequest("That password is too common. Try a phrase of a few unrelated words.");
  }
  const personal = [who.email?.split("@")[0], who.handle, ...(who.displayName?.split(/\s+/) ?? [])]
    .map((p) => p?.toLowerCase().trim())
    .filter((p): p is string => Boolean(p && p.length >= 4));
  if (personal.some((p) => lower.includes(p))) throw badRequest("Don't use your name, handle or email in your password");
}

function isSequence(s: string) {
  const digits = "01234567890123456789";
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const rows = "qwertyuiopasdfghjklzxcvbnm";
  return [digits, letters, rows].some((seq) => seq.includes(s) || [...seq].reverse().join("").includes(s));
}

/**
 * Have I Been Pwned "range" check (k-anonymity): only the first 5 characters of the password's SHA-1
 * leave the server, and the response is padded. Fails open if the service can't be reached.
 */
export async function isBreachedPassword(config: Config, password: string): Promise<boolean> {
  if (!config.breachCheck) return false;
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(`${config.PWNED_PASSWORDS_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "Aurex-password-check" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split("\n").some((line) => {
      const [s, count] = line.trim().split(":");
      return s === suffix && Number(count) > 0;
    });
  } catch {
    return false; // availability over strictness: the other rules still apply
  }
}

/** All password checks for a new password. */
export async function assertStrongPassword(config: Config, password: string, who: PasswordContext = {}) {
  checkPasswordRules(config, password, who);
  if (await isBreachedPassword(config, password)) {
    throw badRequest("This password has appeared in a data breach, so attackers try it first. Please choose a different one.");
  }
}
