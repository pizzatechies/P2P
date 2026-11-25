import { Router } from "express";
import express from "express";
import { businessName, businessPeople } from "../services/business.js";
import { PERSON_DOC_KINDS, personInviteView, savePersonDetails, submitPersonCheck, uploadPersonDocument, type PersonDocKind } from "../services/kybPeople.js";
import { verifyCaptcha } from "../services/captcha.js";
import { joinWaitlist, signupStatus } from "../services/beta.js";
import { parse } from "../lib/validate.js";
import { rateLimit } from "../lib/rateLimit.js";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { notFound } from "../lib/errors.js";
import { findUserByIdentifier, publicProfile } from "../services/users.js";

/** Unauthenticated endpoints used by shareable pages (e.g. /pay/@handle links). */
export function publicRoutes(ctx: Ctx) {
  const r = Router();
  /** Who can sign up right now (the sign-up page shows an invite field or the waitlist). */
  r.get("/signup", (_req, res) => {
    res.json(signupStatus(ctx));
  });

  const waitlistLimiter = rateLimit({ name: "waitlist", windowMs: 60 * 60_000, max: ctx.config.isTest ? 10_000 : 10 });
  r.post("/waitlist", waitlistLimiter, async (req, res) => {
    const body = parse(z.object({ email: z.string().max(200), name: z.string().max(80).optional(), country: z.string().max(2).optional() }), req.body);
    await verifyCaptcha(ctx, req.body?.captchaToken, req.ip);
    res.status(201).json(joinWaitlist(ctx, body.email, body.name, body.country));
  });

  // ---- A company director's or owner's identity check, through their private link ----
  const personLimiter = rateLimit({ name: "kyb-person", windowMs: 15 * 60_000, max: ctx.config.isTest ? 10_000 : 60 });
  const iso2 = z.string().trim().length(2).transform((v) => v.toUpperCase());
  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use dates like 1980-04-23");
  r.get("/kyb-person/:token", personLimiter, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(personInviteView(ctx, String(req.params.token), businessPeople(ctx)));
  });
  r.put("/kyb-person/:token/details", personLimiter, (req, res) => {
    const body = parse(
      z.object({
        dateOfBirth: isoDate,
        nationality: iso2,
        idType: z.enum(["passport", "national_id", "drivers_license"]),
        idNumber: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9 -]+$/, "Letters, numbers, spaces and dashes only"),
        idCountry: iso2,
        idExpiry: isoDate.optional(),
        phone: z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, "Use an international number, e.g. +254 712 345 678").or(z.literal("")).default(""),
        consent: z.boolean(),
      }),
      req.body,
    );
    res.json(savePersonDetails(ctx, String(req.params.token), businessPeople(ctx), body));
  });
  r.post(
    "/kyb-person/:token/documents/:kind",
    personLimiter,
    express.raw({ type: ["image/jpeg", "image/png", "image/webp", "application/octet-stream"], limit: "5mb" }),
    (req, res) => {
      const kind = parse(z.enum(PERSON_DOC_KINDS), req.params.kind) as PersonDocKind;
      res.status(201).json(uploadPersonDocument(ctx, String(req.params.token), businessPeople(ctx), kind, req.body as Buffer));
    },
  );
  r.post("/kyb-person/:token/submit", personLimiter, async (req, res) => {
    res.json(await submitPersonCheck(ctx, String(req.params.token), businessPeople(ctx), req.ip));
  });

  /** Company and contact details for the legal pages; anything not set stays a visible placeholder. */
  r.get("/legal", (_req, res) => {
    const c = ctx.config;
    res.json({
      final: c.LEGAL_FINAL,
      effectiveDate: c.LEGAL_EFFECTIVE_DATE ?? null,
      company: { name: c.LEGAL_COMPANY_NAME ?? null, registrationNumber: c.LEGAL_REGISTRATION_NUMBER ?? null, address: c.LEGAL_ADDRESS ?? null, country: c.LEGAL_COUNTRY ?? null },
      contact: {
        supportEmail: c.SUPPORT_EMAIL ?? null,
        supportPhone: c.SUPPORT_PHONE ?? null,
        complaintsEmail: c.COMPLAINTS_EMAIL ?? c.SUPPORT_EMAIL ?? null,
        dpoName: c.DPO_NAME ?? null,
        dpoEmail: c.DPO_EMAIL ?? null,
      },
    });
  });

  r.get("/users/:handle", (req, res) => {
    const handle = String(req.params.handle).replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) throw notFound("No one with that handle");
    const user = findUserByIdentifier(ctx, `@${handle}`);
    if (!user || user.status !== "active") throw notFound("No one with that handle");
    const business = businessName(ctx, user.id);
    res.json({ user: { ...publicProfile(user), business: business ? { name: business } : null } });
  });
  return r;
}
