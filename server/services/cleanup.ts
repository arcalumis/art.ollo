import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db";
import { processExpiredBoosts } from "./subscription-boost";

interface TrashRow {
	id: string;
	image_path?: string;
	filename?: string;
}

export function cleanupTrashedItems(): void {
	const db = getDb();

	// Clean up generations older than 1 hour
	const oldGenerations = db
		.prepare(
			`SELECT id, image_path FROM generations
			 WHERE deleted_at IS NOT NULL
			 AND deleted_at < datetime('now', '-1 hour')`,
		)
		.all() as TrashRow[];

	for (const row of oldGenerations) {
		if (row.image_path) {
			const filePath = path.join(process.cwd(), "generated-images", row.image_path);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
		db.prepare("DELETE FROM generations WHERE id = ?").run(row.id);
	}

	// Clean up uploads older than 1 hour
	const oldUploads = db
		.prepare(
			`SELECT id, filename FROM uploads
			 WHERE deleted_at IS NOT NULL
			 AND deleted_at < datetime('now', '-1 hour')`,
		)
		.all() as TrashRow[];

	for (const row of oldUploads) {
		if (row.filename) {
			const filePath = path.join(process.cwd(), "uploads", row.filename);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
		db.prepare("DELETE FROM uploads WHERE id = ?").run(row.id);
	}

	const totalCleaned = oldGenerations.length + oldUploads.length;
	if (totalCleaned > 0) {
		console.log(`Cleanup: Permanently deleted ${totalCleaned} trashed items`);
	}

	// Process expired subscription boosts
	processExpiredBoosts();
}

export function startCleanupJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
	// Run immediately on start
	cleanupTrashedItems();

	// Then run periodically
	return setInterval(cleanupTrashedItems, intervalMs);
}
