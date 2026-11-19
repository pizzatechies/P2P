import express, { Router } from "express";
import { applyForBusiness, assertCategory, businessOverview } from "../services/business.js";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { badRequest } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { clearSessionCookie, requireAuth, requireRecentAuth } from "../middleware/auth.js";
import { accountOverview, buildRangeStatement, buildStatement, closeAccount, closureBlockers, exportData, statementCsv, statementPeriods } from "../services/account.js";
import { documentHeaders, readDocument, saveDetails, submitLevel, uploadDocument, verificationOverview, type DocKind } from "../services/kyc.js";
import { audit } from "../services/users.js";

const Level = z.coerce.number().int().pipe(z.union([z.literal(1), z.literal(2)]));
const DOC_KINDS = ["id_front", "id_back", "selfie", "proof_of_address"] as const;

export function accountRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const uploadLimiter = rateLimit({ name: "kyc-upload", windowMs: 60 * 60_000, max: ctx.config.isTest ? 1000 : 30, key: (req) => req.user!.id });
  const exportLimiter = rateLimit({ name: "data-export", windowMs: 60 * 60_000, max: ctx.config.isTest ? 1000 : 5, key: (req) => req.user!.id });

  /** Account number, holder, limits (and how much is left today), balances and verification. */
  r.get("/", async (req, res) => {
    res.json({ account: await accountOverview(ctx, req.user!.id), closureBlockers: closureBlockers(ctx, req.user!.id) });
  });

  // ---- Identity verification ----
  r.get("/verification", (req, res) => {
    res.json(verificationOverview(ctx, req.user!.id));
  });

  r.put("/verification/:level", (req, res) => {
    const level = parse(Level, req.params.level);
    res.json(saveDetails(ctx, req.user!.id, level, req.body));
  });

  /** Upload one document as the raw request body (image or PDF, up to 5 MB). */
  r.post(
    "/documents/:kind",
    uploadLimiter,
    express.raw({ type: ["image/jpeg", "image/png", "image/webp", "application/pdf", "application/octet-stream"], limit: "5mb" }),
    (req, res) => {
      const kind = parse(z.enum(DOC_KINDS), req.params.kind) as DocKind;
      if (!Buffer.isBuffer(req.body)) throw badRequest("Upload a JPEG, PNG or WebP photo, or a PDF");
      const doc = uploadDocument(ctx, req.user!.id, kind, req.body);
      audit(ctx, req.user!.id, "kyc.document_uploaded", { kind, size: doc.size, mime: doc.mime }, req.ip);
      res.status(201).json({ document: doc, verification: verificationOverview(ctx, req.user!.id) });
    },
  );

  /** Your own document (e.g. to check what you uploaded, or as part of your data). */
  r.get("/documents/:id", (req, res) => {
    const doc = readDocument(ctx, String(req.params.id), req.user!.id);
    res.set(documentHeaders(doc));
    res.send(doc.bytes);
  });

  r.post("/verification/:level/submit", async (req, res) => {
    const level = parse(Level, req.params.level);
    res.json(await submitLevel(ctx, req.user!.id, level, req.ip));
  });

  // ---- Statements ----
  r.get("/statements", (req, res) => {
    res.json(statementPeriods(ctx, req.user!.id));
  });

  /** ?currency=KES&format=csv|json */
  r.get("/statements/:period", (req, res) => {
    const st = buildStatement(ctx, req.user!.id, String(req.params.period), String(req.query.currency ?? ""));
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="aurex-statement-${st.period}-${st.currency}.csv"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(statementCsv(st));
      return;
    }
    res.json({ statement: st });
  });

  /** Wallet activity for any date range (up to a year): ?from=2026-01-01&to=2026-03-31&currency=USD, as CSV. */
  r.get("/activity", (req, res) => {
    const st = buildRangeStatement(ctx, req.user!.id, String(req.query.from ?? ""), String(req.query.to ?? ""), String(req.query.currency ?? ""));
    if (req.query.format === "json") {
      res.json({ statement: st });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="aurex-activity-${st.currency}-${String(req.query.from)}-to-${String(req.query.to)}.csv"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(statementCsv(st));
  });

  // ---- Business account ----
  r.get("/business", (req, res) => {
    res.json(businessOverview(ctx, req.user!.id));
  });

  r.put("/business", (req, res) => {
    const body = parse(
      z.object({
        businessName: z.string().trim().min(2).max(100),
        category: z.string().transform(assertCategory),
        registrationNumber: z.string().trim().max(60).optional(),
        country: z.string().trim().length(2),
        website: z.string().trim().url().max(200).optional().or(z.literal("")),
      }),
      req.body,
    );
    res.json(applyForBusiness(ctx, req.user!.id, { ...body, website: body.website || undefined }, req.ip));
  });

  // ---- Your data ----
  r.get("/export", exportLimiter, requireRecentAuth(ctx), (req, res) => {
    const data = exportData(ctx, req.user!.id);
    audit(ctx, req.user!.id, "account.data_exported", {}, req.ip);
    res.setHeader("Content-Disposition", `attachment; filename="aurex-data-${data.exportedAt.slice(0, 10)}.json"`);
    res.json(data);
  });

  r.post("/close", requireRecentAuth(ctx), (req, res) => {
    const { confirmHandle } = parse(z.object({ confirmHandle: z.string().min(1).max(40) }), req.body);
    closeAccount(ctx, req.user!.id, confirmHandle, req.ip);
    clearSessionCookie(ctx, res);
    res.json({ ok: true });
  });

  return r;
}
