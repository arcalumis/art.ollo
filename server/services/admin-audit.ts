/**
 * Admin audit log: every admin mutation records who did what to which target, the state
 * before and after, the reason given, and when. Rows are append-only.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import crypto from "node:crypto";
import { getDb } from "../db";
import { isoOrNull } from "./admin-time";

export interface AuditActor {
	userId: string;
	username: string;
}

export interface AuditEntryInput {
	action: string;
	targetType: string;
	targetId?: string | null;
	before?: unknown;
	after?: unknown;
	reason?: string | null;
	ip?: string | null;
}

function toJson(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}

/** Write one audit row. Call it inside the same transaction as the change when there is one. */
export function writeAudit(actor: AuditActor | undefined, entry: AuditEntryInput): string {
	const id = crypto.randomUUID();
	getDb()
		.prepare(`
			INSERT INTO admin_audit_log
				(id, admin_user_id, admin_username, action, target_type, target_id, before_json, after_json, reason, ip)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			id,
			actor?.userId ?? null,
			actor?.username ?? null,
			entry.action,
			entry.targetType,
			entry.targetId ?? null,
			toJson(entry.before),
			toJson(entry.after),
			entry.reason ?? null,
			entry.ip ?? null,
		);
	return id;
}

export interface AuditRow {
	id: string;
	adminUserId: string | null;
	adminUsername: string | null;
	action: string;
	targetType: string;
	targetId: string | null;
	targetLabel: string | null;
	before: unknown;
	after: unknown;
	reason: string | null;
	createdAt: string | null;
}

export interface AuditFilter {
	action?: string;
	adminUserId?: string;
	targetType?: string;
	targetId?: string;
	q?: string;
	page?: number;
	limit?: number;
}

function parseJson(value: string | null): unknown {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export function listAudit(filter: AuditFilter = {}): { entries: AuditRow[]; total: number; actions: string[] } {
	const db = getDb();
	const where: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (filter.action) {
		where.push("a.action = ?");
		params.push(filter.action);
	}
	if (filter.adminUserId) {
		where.push("a.admin_user_id = ?");
		params.push(filter.adminUserId);
	}
	if (filter.targetType) {
		where.push("a.target_type = ?");
		params.push(filter.targetType);
	}
	if (filter.targetId) {
		where.push("a.target_id = ?");
		params.push(filter.targetId);
	}
	if (filter.q) {
		where.push("(a.reason LIKE ? OR a.admin_username LIKE ? OR u.username LIKE ? OR u.email LIKE ? OR a.target_id = ?)");
		const like = `%${filter.q}%`;
		params.push(like, like, like, like, filter.q);
	}
	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
	const page = Math.max(1, filter.page ?? 1);
	const from = `FROM admin_audit_log a LEFT JOIN users u ON a.target_type = 'user' AND u.id = a.target_id ${whereSql}`;

	const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
	const rows = db
		.prepare(`
			SELECT a.*, u.username AS target_username
			${from}
			ORDER BY datetime(a.created_at) DESC, a.rowid DESC
			LIMIT ? OFFSET ?
		`)
		.all(...params, limit, (page - 1) * limit) as Array<{
		id: string;
		admin_user_id: string | null;
		admin_username: string | null;
		action: string;
		target_type: string;
		target_id: string | null;
		target_username: string | null;
		before_json: string | null;
		after_json: string | null;
		reason: string | null;
		created_at: string | null;
	}>;
	const actions = (
		db.prepare("SELECT DISTINCT action FROM admin_audit_log ORDER BY action").all() as Array<{ action: string }>
	).map((r) => r.action);

	return {
		total,
		actions,
		entries: rows.map((r) => ({
			id: r.id,
			adminUserId: r.admin_user_id,
			adminUsername: r.admin_username,
			action: r.action,
			targetType: r.target_type,
			targetId: r.target_id,
			targetLabel: r.target_username,
			before: parseJson(r.before_json),
			after: parseJson(r.after_json),
			reason: r.reason,
			createdAt: isoOrNull(r.created_at),
		})),
	};
}
