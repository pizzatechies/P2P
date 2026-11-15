import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * The trading academy: short lessons with graded quizzes, plus practice missions detected from the
 * user's demo account. Answers live only on the server, so quizzes count toward a real-account upgrade.
 */
export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  summary: string;
  sections: { heading: string; body: string[] }[];
  quiz: { question: string; options: string[]; answer: number; explain: string }[];
}

export const PASS_MARK = 0.8;

export const LESSONS: Lesson[] = [
  {
    id: "market-basics",
    title: "How the stock market works",
    minutes: 4,
    summary: "Shares, exchanges, prices and when you can trade.",
    sections: [
      {
        heading: "What you're buying",
        body: [
          "A share is a small piece of ownership in a company. If the company grows and earns more, investors usually value each share more, and the price rises. If it struggles, the price can fall, sometimes a long way.",
          "You make money when you sell for more than you paid (or from dividends some companies pay). You lose money when you sell for less.",
        ],
      },
      {
        heading: "Where prices come from",
        body: [
          "Prices are set by buyers and sellers on exchanges such as the NYSE and Nasdaq. The bid is the highest price a buyer will pay right now; the ask is the lowest price a seller will accept. The gap between them is the spread.",
          "US markets trade 9:30 am to 4:00 pm New York time on weekdays. Outside those hours prices can jump when news arrives, so the next opening price may be very different from the last close.",
        ],
      },
      {
        heading: "Funds and diversification",
        body: [
          "An ETF (exchange-traded fund) such as SPY holds hundreds of companies in one share. Owning many companies spreads your risk: one bad result hurts less.",
        ],
      },
    ],
    quiz: [
      { question: "What does owning a share mean?", options: ["You lent the company money", "You own a small part of the company", "You are guaranteed a fixed return"], answer: 1, explain: "A share is part-ownership. Its value can rise or fall; nothing is guaranteed." },
      { question: "The 'ask' price is…", options: ["The lowest price a seller will accept", "The highest price a buyer will pay", "Yesterday's closing price"], answer: 0, explain: "You buy at the ask and sell at the bid; the difference is the spread." },
      { question: "Why might a stock open far from yesterday's close?", options: ["Exchanges reset prices every morning", "News arrived while the market was closed", "It can't; prices only move during the day"], answer: 1, explain: "Overnight news can make the next opening price gap up or down." },
      { question: "What's the main benefit of an ETF like SPY?", options: ["It can't lose money", "It spreads your money across many companies", "It pays a fixed interest rate"], answer: 1, explain: "ETFs diversify, which reduces (but doesn't remove) risk." },
      { question: "Regular US market hours are…", options: ["24 hours a day", "9:30 am – 4:00 pm New York time, weekdays", "Only in the morning"], answer: 1, explain: "Regular sessions run 9:30–16:00 Eastern time on trading days." },
    ],
  },
  {
    id: "order-types",
    title: "Market and limit orders",
    minutes: 4,
    summary: "How orders fill, and when to use each type.",
    sections: [
      {
        heading: "Market orders",
        body: [
          "A market order buys or sells right away at the best price available. It's fast, but in a fast-moving or thinly traded stock you may pay a bit more (or receive a bit less) than the last price you saw. That difference is called slippage.",
        ],
      },
      {
        heading: "Limit orders",
        body: [
          "A limit order sets the worst price you'll accept: a buy limit only fills at or below your price, a sell limit only at or above it. You control the price, but the order may never fill if the market doesn't reach it.",
          "In the Aurex demo account, open limit orders fill automatically when the price reaches your limit, and you can cancel them any time.",
        ],
      },
      {
        heading: "Choosing",
        body: ["Use market orders for large, busy stocks when getting in now matters most. Use limit orders when the price matters more than speed, or in quieter stocks."],
      },
    ],
    quiz: [
      { question: "A market order…", options: ["Fills immediately at the best available price", "Only fills at a price you choose", "Waits until the next day"], answer: 0, explain: "Market orders prioritise speed over price." },
      { question: "A buy limit order at $50 fills…", options: ["At $50 or lower", "At $50 or higher", "At any price"], answer: 0, explain: "A buy limit sets the most you'll pay." },
      { question: "What's slippage?", options: ["A broker fee", "The difference between the expected price and the price you actually got", "A type of limit order"], answer: 1, explain: "Slippage happens when prices move between seeing a quote and the fill." },
      { question: "What's the main risk of a limit order?", options: ["It always fills at a bad price", "It may never fill", "It can't be cancelled"], answer: 1, explain: "If the price never reaches your limit, nothing happens." },
      { question: "When is a limit order usually the better choice?", options: ["When speed matters more than price", "When price matters more than speed", "Never"], answer: 1, explain: "Limits protect your price at the cost of certainty." },
    ],
  },
  {
    id: "risk-management",
    title: "Risk, position size and stop-losses",
    minutes: 5,
    summary: "The habits that keep one bad trade from ruining you.",
    sections: [
      {
        heading: "Risk a little per trade",
        body: [
          "Many traders risk no more than 1–2% of their account on any single trade. With $10,000, that's $100–$200 you could lose if the trade goes wrong, so a string of losses is survivable.",
          "Position size follows from that: if you'd exit 5% below your entry, a $200 risk means a position of about $4,000.",
        ],
      },
      {
        heading: "Stop-losses and take-profits",
        body: [
          "A stop-loss is the price at which you've decided you were wrong and you'll sell. Deciding it before you buy takes emotion out of the moment. A take-profit is where you'll lock in gains.",
          "The AI analyst suggests both for every buy idea, and the autopilot can apply them for you.",
        ],
      },
      {
        heading: "Diversify and never chase losses",
        body: ["Spread money across several companies and sectors. Doubling down to win back a loss is how small losses become big ones. Only trade money you can afford to lose."],
      },
    ],
    quiz: [
      { question: "With a $10,000 account and a 1% risk rule, the most you'd lose on one trade is…", options: ["$10", "$100", "$1,000"], answer: 1, explain: "1% of $10,000 is $100." },
      { question: "When should you decide your stop-loss?", options: ["Before you enter the trade", "After the price has fallen a lot", "Never; always hold"], answer: 0, explain: "Planning the exit in advance keeps emotions out of it." },
      { question: "You risk $200 and plan to exit 5% below your entry. Roughly how big is the position?", options: ["$1,000", "$4,000", "$20,000"], answer: 1, explain: "$200 ÷ 5% = $4,000." },
      { question: "After a loss, the safest habit is to…", options: ["Double the next position to win it back", "Stick to your normal size and plan", "Stop using stop-losses"], answer: 1, explain: "Chasing losses with bigger bets usually makes them worse." },
      { question: "Diversification means…", options: ["Putting everything in your best idea", "Spreading money across different companies and sectors", "Trading as often as possible"], answer: 1, explain: "Spreading risk limits the damage from any one holding." },
    ],
  },
  {
    id: "reading-charts",
    title: "Reading a price chart",
    minutes: 4,
    summary: "Trends, moving averages, RSI and their limits.",
    sections: [
      {
        heading: "Trend and moving averages",
        body: [
          "A moving average smooths prices: the 20-day SMA is the average close of the last 20 days. Price above a rising average suggests an uptrend; below a falling one suggests a downtrend. When a short average crosses a long one, trend-followers take note.",
        ],
      },
      {
        heading: "RSI",
        body: [
          "The Relative Strength Index (0–100) measures recent momentum. Above 70 is often called overbought, below 30 oversold. These are warnings, not guarantees: strong trends can stay overbought for a long time.",
        ],
      },
      {
        heading: "Know the limits",
        body: ["Indicators describe the past. They help you stay disciplined but can't predict news. Combine them with risk management, and treat any single signal with healthy doubt."],
      },
    ],
    quiz: [
      { question: "A 20-day simple moving average is…", options: ["The average closing price of the last 20 days", "The highest price in 20 days", "A prediction of the next 20 days"], answer: 0, explain: "It's a smoothed average of past closes." },
      { question: "An RSI above 70 usually means…", options: ["The stock is guaranteed to fall", "Momentum is strong and the stock may be overbought", "The company is bankrupt"], answer: 1, explain: "It's a caution flag, not a certainty." },
      { question: "Price trading above a rising moving average suggests…", options: ["An uptrend", "A downtrend", "Nothing at all"], answer: 0, explain: "That's a classic sign of an uptrend." },
      { question: "Can indicators predict surprise news?", options: ["Yes, always", "No, they're based on past prices", "Only RSI can"], answer: 1, explain: "Indicators look backwards; news is unpredictable." },
      { question: "The best way to use indicators is…", options: ["As one input alongside risk management", "As a guaranteed buy/sell signal", "To ignore stop-losses"], answer: 0, explain: "They support decisions; they don't replace discipline." },
    ],
  },
  {
    id: "ai-trading",
    title: "Trading with the AI analyst",
    minutes: 3,
    summary: "What AI signals are, and how autopilot stays inside your limits.",
    sections: [
      {
        heading: "Signals are decision aids",
        body: [
          "The AI analyst reads the chart and indicators and suggests buy, sell or hold with a confidence level, a size, a stop-loss and a take-profit. It explains its reasoning and the risks. It can be wrong, and it isn't financial advice.",
        ],
      },
      {
        heading: "Guardrails",
        body: [
          "AI-suggested buys are capped at a share of your portfolio, each signal can be used once, and you confirm every order unless you switch on Autopilot.",
          "Autopilot only trades inside the limits you set (position size, total invested, trades per day, minimum confidence) and pauses itself at your daily loss limit.",
        ],
      },
    ],
    quiz: [
      { question: "An AI signal with 80% confidence…", options: ["Is guaranteed to be right", "Is the AI's estimate, and can still be wrong", "Means 80% profit"], answer: 1, explain: "Confidence is an estimate, not a promise." },
      { question: "Without Autopilot, AI-suggested orders…", options: ["Execute automatically", "Need your confirmation", "Are ignored"], answer: 1, explain: "You confirm each suggested order." },
      { question: "Autopilot pauses itself when…", options: ["It reaches your daily loss limit", "The market opens", "You log in"], answer: 0, explain: "The daily loss stop protects you on bad days." },
      { question: "Before trusting a strategy with real money you should…", options: ["Practise it in the demo account first", "Use your whole balance at once", "Skip stop-losses"], answer: 0, explain: "The demo account exists exactly for this." },
      { question: "AI-suggested buys are capped at…", options: ["A set share of your portfolio", "Nothing; they can use everything", "$1"], answer: 0, explain: "Position caps keep one AI idea from taking over your account." },
    ],
  },
  {
    id: "going-live",
    title: "Before you trade real money",
    minutes: 4,
    summary: "Costs, taxes, emotions and how real accounts work.",
    sections: [
      {
        heading: "Real money feels different",
        body: [
          "Losses hurt more when they're real, and that makes people break their own rules. Start small, keep the same risk limits you practised with, and write down why you take each trade.",
        ],
      },
      {
        heading: "Costs and taxes",
        body: [
          "Spreads, any commissions and currency conversion all reduce returns. Profits may be taxable where you live; keep records of every trade.",
        ],
      },
      {
        heading: "How real accounts work here",
        body: [
          "Real trades go through a licensed brokerage account in your own name (Alpaca). The broker holds your investments, verifies your identity and may offer investor protection. Aurex never holds your securities.",
          "Only invest money you can afford to lose. Past performance, in the demo account or anywhere else, doesn't guarantee future results.",
        ],
      },
    ],
    quiz: [
      { question: "Who holds your investments in a real account?", options: ["Aurex", "A licensed brokerage in your name", "Nobody"], answer: 1, explain: "Your broker holds the securities; Aurex connects to it." },
      { question: "A good first step when moving to real money is…", options: ["Start small and keep your practised risk limits", "Invest everything at once", "Stop using stop-losses"], answer: 0, explain: "Small positions let you adjust to real emotions." },
      { question: "Which of these reduce your returns?", options: ["Spreads, fees and currency conversion", "Only taxes", "Nothing"], answer: 0, explain: "All costs add up; account for them." },
      { question: "Good demo results mean…", options: ["Guaranteed real profits", "You've practised, but future results aren't guaranteed", "You can skip risk management"], answer: 1, explain: "Practice helps, but markets change." },
      { question: "You should only invest money that…", options: ["You can afford to lose", "You borrowed", "You need next month"], answer: 0, explain: "Never trade money you need." },
    ],
  },
];

/** Practice missions, detected from what the user actually did in their demo account. */
const MISSIONS: { id: string; title: string; hint: string; done: (ctx: Ctx, userId: string) => boolean }[] = [
  {
    id: "first-buy",
    title: "Buy your first share",
    hint: "On the Trading page, pick a stock and place a market buy.",
    done: (ctx, u) => Boolean(one(ctx.db, "SELECT 1 FROM orders WHERE user_id = ? AND broker = 'paper' AND side = 'buy' AND status = 'filled' LIMIT 1", u)),
  },
  {
    id: "limit-order",
    title: "Place a limit order",
    hint: "Choose Limit and set the price you're willing to pay.",
    done: (ctx, u) => Boolean(one(ctx.db, "SELECT 1 FROM orders WHERE user_id = ? AND broker = 'paper' AND type = 'limit' LIMIT 1", u)),
  },
  {
    id: "first-sell",
    title: "Sell a position",
    hint: "Sell some or all of a holding to lock in a gain or cut a loss.",
    done: (ctx, u) => Boolean(one(ctx.db, "SELECT 1 FROM orders WHERE user_id = ? AND broker = 'paper' AND side = 'sell' AND status = 'filled' LIMIT 1", u)),
  },
  {
    id: "diversify",
    title: "Own three different stocks",
    hint: "Spread your demo money across at least three companies.",
    done: (ctx, u) => (one<{ n: number }>(ctx.db, "SELECT COUNT(DISTINCT symbol) AS n FROM orders WHERE user_id = ? AND broker = 'paper' AND side = 'buy' AND status = 'filled'", u)?.n ?? 0) >= 3,
  },
  {
    id: "ask-ai",
    title: "Ask the AI analyst",
    hint: "Analyze a stock and read its reasoning, stop-loss and risks.",
    done: (ctx, u) => Boolean(one(ctx.db, "SELECT 1 FROM ai_signals WHERE user_id = ? LIMIT 1", u)),
  },
  {
    id: "watchlist",
    title: "Build a watchlist",
    hint: "Add at least three symbols you want to follow.",
    done: (ctx, u) => (one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?", u)?.n ?? 0) >= 3,
  },
];

export function demoTradeCount(ctx: Ctx, userId: string) {
  return one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND broker = 'paper' AND status = 'filled'", userId)?.n ?? 0;
}

export function learningOverview(ctx: Ctx, userId: string) {
  const passed = new Map(all<{ item_id: string; score: number; completed_at: string }>(ctx.db, "SELECT item_id, score, completed_at FROM learning_progress WHERE user_id = ?", userId).map((r) => [r.item_id, r]));
  const lessons = LESSONS.map((l) => ({
    id: l.id,
    title: l.title,
    minutes: l.minutes,
    summary: l.summary,
    sections: l.sections,
    // Questions and options only: answers never leave the server.
    quiz: l.quiz.map((q) => ({ question: q.question, options: q.options })),
    passed: passed.has(l.id),
    score: passed.get(l.id)?.score ?? null,
    completedAt: passed.get(l.id)?.completed_at ?? null,
  }));
  const missions = MISSIONS.map((m) => ({ id: m.id, title: m.title, hint: m.hint, done: m.done(ctx, userId) }));
  const total = lessons.length + missions.length;
  const done = lessons.filter((l) => l.passed).length + missions.filter((m) => m.done).length;
  return { lessons, missions, progress: Math.round((done / total) * 100), passMark: PASS_MARK, demoTrades: demoTradeCount(ctx, userId) };
}

export function gradeQuiz(ctx: Ctx, userId: string, lessonId: string, answers: number[]) {
  const lesson = LESSONS.find((l) => l.id === lessonId);
  if (!lesson) throw notFound("No such lesson");
  if (answers.length !== lesson.quiz.length) throw badRequest(`Answer all ${lesson.quiz.length} questions`);
  const results = lesson.quiz.map((q, i) => ({ correct: answers[i] === q.answer, answer: q.answer, explain: q.explain }));
  const score = results.filter((r) => r.correct).length / lesson.quiz.length;
  const passed = score >= PASS_MARK;
  if (passed) {
    run(
      ctx.db,
      `INSERT INTO learning_progress (user_id, item_id, score, completed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, item_id) DO UPDATE SET score = MAX(score, excluded.score), completed_at = excluded.completed_at`,
      userId,
      lessonId,
      score,
      nowIso(),
    );
  }
  return { score, passed, results };
}

export function lessonsPassed(ctx: Ctx, userId: string) {
  const ids = new Set(all<{ item_id: string }>(ctx.db, "SELECT item_id FROM learning_progress WHERE user_id = ?", userId).map((r) => r.item_id));
  return LESSONS.filter((l) => ids.has(l.id)).length;
}
