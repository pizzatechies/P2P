import type { Config } from "../config.js";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain, brand-styled HTML version of a short text email. */
export function simpleHtml(title: string, paragraphs: string[], highlight?: string, button?: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#faf8f3;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1a14">
<div style="max-width:480px;margin:24px auto;background:#fff;border:1px solid #ece6d6;border-radius:14px;padding:28px">
<div style="font-weight:700;font-size:18px;color:#8a6510;margin-bottom:16px">Aurex</div>
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
${highlight ? `<div style="font-size:32px;letter-spacing:6px;font-weight:700;background:#fbf3dc;border-radius:10px;padding:14px;text-align:center;margin:16px 0">${escapeHtml(highlight)}</div>` : ""}
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`).join("")}
${button ? `<p style="margin:20px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#d4af37;color:#1c1a14;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px">${escapeHtml(button.label)}</a></p><p style="font-size:12px;color:#8b8577;word-break:break-all">${escapeHtml(button.url)}</p>` : ""}
<p style="font-size:12px;color:#8b8577;margin-top:20px">You're receiving this because of activity on your Aurex account. Aurex will never ask for your password or codes by email or phone.</p>
</div></body></html>`;
}

/**
 * Sends an email through Resend, or logs it in development. Returns false when nothing could be
 * sent. Never throws: email problems must not break sign-up or security flows.
 */
export async function sendEmail(config: Config, email: Email): Promise<boolean> {
  if (config.emailDelivery === "none") return false;
  if (config.emailDelivery === "console") {
    if (!config.isTest) console.log(`[email] to=${email.to} subject="${email.subject}"\n${email.text}`);
    return true;
  }
  try {
    const res = await fetch(`${config.RESEND_BASE_URL}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.emailFrom, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[email] Resend refused the message: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.warn(`[email] couldn't reach Resend: ${(err as Error).message}`);
    return false;
  }
}
