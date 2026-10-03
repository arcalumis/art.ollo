import crypto from "node:crypto";
import { Resend } from "resend";
import { getDb } from "../db";

const isProduction = process.env.NODE_ENV === "production";
const APP_URL = process.env.APP_URL || "http://localhost:5173";
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

export interface SendResult {
	success: boolean;
	error?: string;
}

export interface OutgoingEmail {
	to: string;
	subject: string;
	html: string;
	/** Link included in the email; only ever logged in non-production when email is disabled. */
	devLink?: string;
}

export type EmailTransport = (email: OutgoingEmail) => Promise<SendResult>;

// Lazily constructed: `new Resend(undefined)` throws, which used to crash the server at import
// time whenever RESEND_API_KEY was missing.
let resendClient: Resend | null = null;

const resendTransport: EmailTransport = async ({ to, subject, html, devLink }) => {
	// Tests that don't install a fake transport must never reach Resend.
	if (process.env.NODE_ENV === "test") return { success: false, error: "Email disabled in tests" };
	const apiKey = process.env.RESEND_API_KEY;
	if (!apiKey) {
		if (isProduction) {
			console.error("[email] RESEND_API_KEY not configured; cannot send email");
			return { success: false, error: "Email not configured" };
		}
		console.warn(`[email] Email disabled (no RESEND_API_KEY). Would send "${subject}" to ${to}`);
		if (devLink) console.log(`[email][dev only] ${devLink}`);
		return { success: true };
	}
	if (!resendClient) resendClient = new Resend(apiKey);
	try {
		const { error } = await resendClient.emails.send({ from: FROM_EMAIL, to, subject, html });
		if (error) {
			console.error(`[email] Resend rejected "${subject}":`, error.message);
			return { success: false, error: error.message };
		}
		return { success: true };
	} catch (err) {
		console.error(`[email] Resend request failed for "${subject}":`, err instanceof Error ? err.message : err);
		return { success: false, error: String(err) };
	}
};

let transport: EmailTransport = resendTransport;

/** Replace the outbound transport (tests). Pass null to restore Resend. */
export function setEmailTransport(t: EmailTransport | null): void {
	transport = t ?? resendTransport;
}

function sendEmail(email: OutgoingEmail): Promise<SendResult> {
	return transport(email);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- Flood protection ----

/**
 * Mail the user's own payments and balance trigger. It has its own budget (per recipient and
 * global), so a flood of sign-in requests can never use up the room receipts need.
 */
const TRANSACTIONAL_KINDS = ["receipt", "payment_failed", "low_credits", "email_changed"] as const;
const TRANSACTIONAL_SET = new Set<string>(TRANSACTIONAL_KINDS);
const TRANSACTIONAL_SQL_LIST = TRANSACTIONAL_KINDS.map((k) => `'${k}'`).join(", ");

interface Budget {
	recipientHourly: number;
	recipientDaily: number;
	globalDaily: number;
	/** Only for mail a visitor can trigger (auth); transactional mail has no requesting IP. */
	ipDaily: number | null;
}

function envCap(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function budgetFor(transactional: boolean): Budget {
	return transactional
		? {
				recipientHourly: 10,
				recipientDaily: 20,
				globalDaily: envCap("EMAIL_TRANSACTIONAL_DAILY_CAP", 500),
				ipDaily: null,
			}
		: {
				recipientHourly: 3,
				recipientDaily: 10,
				globalDaily: envCap("EMAIL_DAILY_CAP", 500),
				ipDaily: envCap("EMAIL_PER_IP_DAILY_CAP", 20),
			};
}

/**
 * Reserve an email send for `recipient`. Returns false (and records nothing) when a cap for the
 * kind's budget is exhausted: per recipient (hourly/daily), per requesting IP (daily, auth mail
 * only) or global (daily). Check + insert run in one transaction so concurrent requests cannot
 * both squeeze past a limit.
 */
export function reserveEmailSend(recipient: string, kind: string, ip?: string): boolean {
	const db = getDb();
	const transactional = TRANSACTIONAL_SET.has(kind);
	const budget = budgetFor(transactional);
	const inBudget = transactional ? `kind IN (${TRANSACTIONAL_SQL_LIST})` : `kind NOT IN (${TRANSACTIONAL_SQL_LIST})`;
	return db.transaction(() => {
		const counts = db
			.prepare(`
				SELECT
					SUM(CASE WHEN recipient = ? AND created_at > datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS hour,
					SUM(CASE WHEN recipient = ? THEN 1 ELSE 0 END) AS day,
					SUM(CASE WHEN ip IS NOT NULL AND ip = ? THEN 1 ELSE 0 END) AS from_ip,
					COUNT(*) AS total
				FROM email_send_log
				WHERE created_at > datetime('now', '-1 day') AND ${inBudget}
			`)
			.get(recipient, recipient, ip ?? null) as {
			hour: number | null;
			day: number | null;
			from_ip: number | null;
			total: number;
		};

		if ((counts.hour ?? 0) >= budget.recipientHourly || (counts.day ?? 0) >= budget.recipientDaily) {
			console.warn(`[email] Per-recipient cap reached for ${recipient} (${kind}); not sending`);
			return false;
		}
		if (ip && budget.ipDaily !== null && (counts.from_ip ?? 0) >= budget.ipDaily) {
			console.warn(`[email] Per-IP daily cap reached for ${ip} (${kind}); not sending`);
			return false;
		}
		if (counts.total >= budget.globalDaily) {
			console.error(
				`[email] GLOBAL daily ${transactional ? "transactional" : "auth"} email cap (${budget.globalDaily}) reached; not sending ${kind}`,
			);
			return false;
		}
		db.prepare("INSERT INTO email_send_log (id, recipient, kind, ip) VALUES (?, ?, ?, ?)").run(
			crypto.randomUUID(),
			recipient,
			kind,
			ip ?? null,
		);
		return true;
	})();
}

// ---- Templates ----

function layout(opts: {
	gradient: string;
	title: string;
	greeting: string;
	body: string;
	buttonUrl: string;
	buttonLabel: string;
	footer: string;
	showRawLink?: boolean;
}): string {
	const rawLink = opts.showRawLink
		? `
    <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
      Or copy and paste this link into your browser:
    </p>
    <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">
      ${opts.buttonUrl}
    </p>`
		: "";
	return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${opts.gradient}; padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">${opts.title}</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
    <p style="font-size: 16px;">${opts.greeting}</p>

    <p style="font-size: 16px;">${opts.body}</p>

    <a href="${opts.buttonUrl}" style="display: inline-block; background: ${opts.gradient}; color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 600; margin: 20px 0; font-size: 16px;">
      ${opts.buttonLabel}
    </a>
${rawLink}

    <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
      ${opts.footer}
    </p>
  </div>
</body>
</html>
`;
}

const MAGIC_GRADIENT = "linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)";

export async function sendWelcomeEmail(email: string, username: string): Promise<SendResult> {
	return sendEmail({
		to: email,
		subject: "Welcome to ollo.art",
		html: layout({
			gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
			title: "Welcome to ollo.art!",
			greeting: `Hi <strong>${escapeHtml(username)}</strong>,`,
			body: "Your account has been created and is ready to use.",
			buttonUrl: APP_URL,
			buttonLabel: "Get Started",
			footer: "If you didn't expect this email, please ignore it or contact support.",
		}),
	});
}

function magicLinkUrl(token: string, rememberMe: boolean): string {
	return `${APP_URL}/auth/magic-link?token=${token}&rememberMe=${rememberMe}`;
}

export async function sendMagicLinkEmail(
	email: string,
	username: string,
	token: string,
	rememberMe: boolean,
): Promise<SendResult> {
	const url = magicLinkUrl(token, rememberMe);
	return sendEmail({
		to: email,
		subject: "Your sign-in link for ollo.art",
		devLink: url,
		html: layout({
			gradient: MAGIC_GRADIENT,
			title: "Sign In to ollo.art",
			greeting: `Hi <strong>${escapeHtml(username)}</strong>,`,
			body: "Click the button below to sign in to your account. This link will expire in 15 minutes.",
			buttonUrl: url,
			buttonLabel: "Sign In Now",
			footer: "If you didn't request this link, you can safely ignore this email.",
			showRawLink: true,
		}),
	});
}

/** Sent when someone requests a link for an email with no account: clicking it creates the account. */
export async function sendSignupLinkEmail(email: string, token: string, rememberMe: boolean): Promise<SendResult> {
	const url = magicLinkUrl(token, rememberMe);
	return sendEmail({
		to: email,
		subject: "Create your ollo.art account",
		devLink: url,
		html: layout({
			gradient: MAGIC_GRADIENT,
			title: "Welcome to ollo.art",
			greeting: "Hi there,",
			body: "Click the button below to create your ollo.art account and sign in. This link will expire in 15 minutes.",
			buttonUrl: url,
			buttonLabel: "Create My Account",
			footer: "If you didn't request this, you can safely ignore this email. No account will be created.",
			showRawLink: true,
		}),
	});
}

export async function sendPasswordResetEmail(email: string, username: string, token: string): Promise<SendResult> {
	const url = `${APP_URL}/auth/reset-password?token=${token}`;
	return sendEmail({
		to: email,
		subject: "Reset Your ollo.art Password",
		devLink: url,
		html: layout({
			gradient: "linear-gradient(135deg, #f43f5e 0%, #ec4899 100%)",
			title: "Reset Your Password",
			greeting: `Hi <strong>${escapeHtml(username)}</strong>,`,
			body: "We received a request to reset your password. Click the button below to choose a new password. This link will expire in 1 hour.",
			buttonUrl: url,
			buttonLabel: "Reset Password",
			footer:
				"If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.",
			showRawLink: true,
		}),
	});
}

// ---- Transactional (billing) emails ----
//
// Plain, calm layout: no gradients, images or tracking pixels. Every send goes through the
// same flood caps as auth email (reserveEmailSend) with its own kind.

function formatMoney(amountCents: number, currency = "usd"): string {
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(
			amountCents / 100,
		);
	} catch {
		return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
}

function plainLayout(opts: {
	heading: string;
	paragraphs: string[];
	buttonUrl: string;
	buttonLabel: string;
	footer: string;
}): string {
	const body = opts.paragraphs.map((p) => `<p style="font-size: 16px; margin: 0 0 16px;">${p}</p>`).join("\n    ");
	return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #152126; background: #eceae4; margin: 0; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background: #f8f7f3; border: 1px solid #d9d6cc; border-radius: 12px; padding: 32px;">
    <p style="font-size: 20px; margin: 0 0 24px; color: #152126;">ollo</p>
    <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 16px;">${opts.heading}</h1>
    ${body}
    <a href="${opts.buttonUrl}" style="display: inline-block; background: #152126; color: #f8f7f3; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0 24px;">${opts.buttonLabel}</a>
    <p style="font-size: 13px; color: #59696a; margin: 0;">${opts.footer}</p>
  </div>
</body>
</html>
`;
}

export interface ReceiptData {
	amountCents: number;
	currency?: string;
	description: string;
	date?: Date;
	invoiceUrl?: string | null;
}

export async function sendPaymentReceiptEmail(to: string, data: ReceiptData): Promise<SendResult> {
	if (!reserveEmailSend(to, "receipt")) return { success: false, error: "Send cap reached" };
	const amount = formatMoney(data.amountCents, data.currency);
	const date = (data.date ?? new Date()).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	const paragraphs = [
		`We received your payment of <strong>${amount}</strong> on ${date}.`,
		`For: ${escapeHtml(data.description)}`,
	];
	if (data.invoiceUrl) {
		paragraphs.push(`<a href="${escapeHtml(data.invoiceUrl)}" style="color: #2d6f61;">View or download the invoice</a>`);
	}
	return sendEmail({
		to,
		subject: `Your ollo.art receipt for ${amount}`,
		html: plainLayout({
			heading: "Payment received",
			paragraphs,
			buttonUrl: `${APP_URL}/billing`,
			buttonLabel: "View billing",
			footer: "Keep this email for your records. Questions about a charge? Reply to this email.",
		}),
	});
}

export async function sendPaymentFailedEmail(
	to: string,
	data: { amountCents: number; currency?: string },
): Promise<SendResult> {
	if (!reserveEmailSend(to, "payment_failed")) return { success: false, error: "Send cap reached" };
	const amount = formatMoney(data.amountCents, data.currency);
	return sendEmail({
		to,
		subject: "Your ollo.art payment didn't go through",
		html: plainLayout({
			heading: "Your payment didn't go through",
			paragraphs: [
				`We couldn't charge <strong>${amount}</strong> for your ollo.art plan.`,
				"Update your card from the billing page to keep your plan and monthly credits. Credits you already have stay in your account.",
			],
			buttonUrl: `${APP_URL}/billing`,
			buttonLabel: "Update payment method",
			footer: "Your bank may have declined the charge, or the card may have expired.",
		}),
	});
}

export async function sendLowCreditsEmail(to: string, data: { balance: number }): Promise<SendResult> {
	if (!reserveEmailSend(to, "low_credits")) return { success: false, error: "Send cap reached" };
	const left = data.balance === 1 ? "1 credit" : `${Math.max(0, data.balance)} credits`;
	return sendEmail({
		to,
		subject: `You have ${left} left on ollo.art`,
		html: plainLayout({
			heading: `You have ${left} left`,
			paragraphs: [
				"That may not cover your next image. Pick a plan for monthly credits, or top up once from your billing page.",
				`<a href="${APP_URL}/billing" style="color: #2d6f61;">Top up from billing</a>`,
			],
			buttonUrl: `${APP_URL}/pricing`,
			buttonLabel: "See plans",
			footer: "We send this at most once a week.",
		}),
	});
}

/**
 * Confirm a change of sign-in email. Sent to the NEW address; nothing changes until the link is
 * opened. The caller reserves the send (reserveEmailSend) first.
 */
export async function sendEmailChangeEmail(to: string, username: string, token: string): Promise<SendResult> {
	const url = `${APP_URL}/settings?confirmEmail=${token}`;
	return sendEmail({
		to,
		subject: "Confirm your new ollo.art email",
		devLink: url,
		html: plainLayout({
			heading: "Confirm your new email",
			paragraphs: [
				`Hi ${escapeHtml(username)}, you asked to use this address to sign in to ollo.art.`,
				"Open the link below to confirm it. Until you do, your old address stays in place. The link expires in 1 hour.",
			],
			buttonUrl: url,
			buttonLabel: "Confirm new email",
			footer: "If you didn't ask for this, ignore this email and nothing will change.",
		}),
	});
}

/**
 * "Confirm it's you" link for a sensitive account change (email or password). Sent to the
 * account's CURRENT address. The caller reserves the send first.
 */
export async function sendReauthEmail(to: string, username: string, token: string): Promise<SendResult> {
	const url = `${APP_URL}/settings?reauth=${token}`;
	return sendEmail({
		to,
		subject: "Confirm it's you on ollo.art",
		devLink: url,
		html: plainLayout({
			heading: "Confirm it's you",
			paragraphs: [
				`Hi ${escapeHtml(username)}, someone signed in to your ollo.art account asked to change its email or password.`,
				"If that was you, open the link below on the same device to continue. The link expires in 15 minutes.",
			],
			buttonUrl: url,
			buttonLabel: "Confirm it's me",
			footer:
				"If this wasn't you, don't open the link. Your account is unchanged. Sign out everywhere from Settings, or reply to this email or write to support@matahari.dev for help.",
		}),
	});
}

/** Sent to the OLD address after the sign-in email changed, so a takeover can't go unnoticed. */
export async function sendEmailChangedNotice(to: string, username: string, newEmail: string): Promise<SendResult> {
	if (!reserveEmailSend(to, "email_changed")) return { success: false, error: "Send cap reached" };
	return sendEmail({
		to,
		subject: "Your ollo.art email was changed",
		html: plainLayout({
			heading: "Your sign-in email was changed",
			paragraphs: [
				`Hi ${escapeHtml(username)}, the email on your ollo.art account was changed to <strong>${escapeHtml(newEmail)}</strong>. Sign-in links, receipts and notices now go there, and this address no longer works for signing in.`,
				"If you made this change, there's nothing else to do.",
				"If you didn't, reply to this email or write to <a href=\"mailto:support@matahari.dev\" style=\"color: #2d6f61;\">support@matahari.dev</a> from this address and we'll help you get the account back.",
			],
			buttonUrl: "mailto:support@matahari.dev",
			buttonLabel: "Contact support",
			footer: "We send this notice to your previous address every time the account email changes.",
		}),
	});
}

function userEmail(userId: string): string | null {
	const row = getDb().prepare("SELECT email FROM users WHERE id = ?").get(userId) as
		| { email: string | null }
		| undefined;
	return row?.email || null;
}

/** Claim a dedupe key; true only for the first caller. */
function claimTransactional(dedupeKey: string, userId: string, kind: string): boolean {
	const result = getDb()
		.prepare("INSERT OR IGNORE INTO transactional_email_log (dedupe_key, user_id, kind) VALUES (?, ?, ?)")
		.run(dedupeKey, userId, kind);
	return result.changes === 1;
}

/** Give a dedupe key back after a send that didn't happen, so a later trigger can retry it. */
function releaseTransactional(dedupeKey: string): void {
	getDb().prepare("DELETE FROM transactional_email_log WHERE dedupe_key = ?").run(dedupeKey);
}

/** Returns whether the email went out. Never throws. */
async function safely(label: string, send: () => Promise<SendResult>): Promise<boolean> {
	try {
		const result = await send();
		if (!result.success) console.warn(`[email] ${label} not sent: ${result.error}`);
		return result.success;
	} catch (err) {
		console.error(`[email] ${label} failed:`, err instanceof Error ? err.message : err);
		return false;
	}
}

/**
 * Claim the dedupe key (so concurrent triggers send once), send, and release the key if the
 * send didn't happen (send cap, provider error) so it isn't marked as sent forever.
 */
async function sendOnce(
	dedupeKey: string,
	userId: string,
	kind: string,
	send: (to: string) => Promise<SendResult>,
): Promise<void> {
	try {
		const to = userEmail(userId);
		if (!to || !claimTransactional(dedupeKey, userId, kind)) return;
		const ok = await safely(kind, () => send(to));
		if (!ok) releaseTransactional(dedupeKey);
	} catch (err) {
		console.error(`[email] ${kind} failed:`, err instanceof Error ? err.message : err);
	}
}

/** Send a receipt at most once per dedupe key (e.g. `receipt:<invoice id>`). Never throws. */
export async function sendReceiptOnce(userId: string, dedupeKey: string, data: ReceiptData): Promise<void> {
	await sendOnce(dedupeKey, userId, "receipt", (to) => sendPaymentReceiptEmail(to, data));
}

/** Send a payment-failed notice at most once per dedupe key (e.g. `failed:<invoice id>`). Never throws. */
export async function sendPaymentFailedOnce(
	userId: string,
	dedupeKey: string,
	data: { amountCents: number; currency?: string },
): Promise<void> {
	await sendOnce(dedupeKey, userId, "payment_failed", (to) => sendPaymentFailedEmail(to, data));
}

export const LOW_CREDIT_THRESHOLD = 5;

/** Low-balance nudge: balance below 5, at most once per user per 7 days. Never throws. */
export async function maybeSendLowCreditEmail(userId: string, balance: number): Promise<void> {
	try {
		if (balance >= LOW_CREDIT_THRESHOLD) return;
		const to = userEmail(userId);
		if (!to) return;
		const claimed = getDb()
			.prepare(
				`UPDATE users SET low_credit_email_at = datetime('now')
				WHERE id = ? AND (low_credit_email_at IS NULL OR datetime(low_credit_email_at) < datetime('now', '-7 days'))`,
			)
			.run(userId);
		if (claimed.changes !== 1) return;
		await safely("low credits", () => sendLowCreditsEmail(to, { balance }));
	} catch (err) {
		console.error("[email] low credits failed:", err instanceof Error ? err.message : err);
	}
}

