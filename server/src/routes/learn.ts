import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { gradeQuiz, learningOverview } from "../services/learn.js";
import { audit } from "../services/users.js";

export function learnRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const quizLimiter = rateLimit({ name: "quiz", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 20, key: (req) => req.user!.id });

  r.get("/", (req, res) => {
    res.json(learningOverview(ctx, req.user!.id));
  });

  r.post("/lessons/:id/quiz", quizLimiter, (req, res) => {
    const { answers } = parse(z.object({ answers: z.array(z.number().int().min(0).max(9)).max(20) }), req.body);
    const result = gradeQuiz(ctx, req.user!.id, String(req.params.id), answers);
    if (result.passed) audit(ctx, req.user!.id, "learn.quiz_passed", { lesson: String(req.params.id), score: result.score }, req.ip);
    res.json(result);
  });

  return r;
}
