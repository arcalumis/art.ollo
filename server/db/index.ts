import { Database } from "bun:sqlite";
import path from "node:path";
import { initializeSchema } from "./schema";

const DB_PATH = path.join(process.cwd(), "data", "generations.db");

let db: Database | null = null;
let checkpointInterval: NodeJS.Timeout | null = null;

export function getDb(): Database {
	if (!db) {
		db = new Database(DB_PATH, { create: true });
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL"); // Ensure durability with WAL
		db.exec("PRAGMA busy_timeout = 5000"); // Wait up to 5s if db is locked
		initializeSchema(db);

		// Checkpoint WAL every 30 seconds to ensure data persistence
		checkpointInterval = setInterval(() => {
			try {
				db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch (e) {
				console.error("WAL checkpoint failed:", e);
			}
		}, 30000);
	}
	return db;
}

export function closeDb(): void {
	if (checkpointInterval) {
		clearInterval(checkpointInterval);
		checkpointInterval = null;
	}
	if (db) {
		// Checkpoint WAL to ensure all changes are persisted before closing
		try {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (e) {
			console.error("Failed to checkpoint WAL:", e);
		}
		db.close();
		db = null;
	}
}
