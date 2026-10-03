import fs from "node:fs";
import path from "node:path";

/**
 * On-disk locations for generated images and user uploads.
 *
 * Production uses <cwd>/generated-images and <cwd>/uploads (the same paths
 * server/app.ts serves statically). The env overrides exist so tests can point
 * the generation pipeline at a temp directory; they are resolved on every call
 * so a test can set them after modules are loaded.
 */
export function getImagesDir(): string {
	return process.env.OLLO_IMAGES_DIR || path.join(process.cwd(), "generated-images");
}

export function getUploadsDir(): string {
	return process.env.OLLO_UPLOADS_DIR || path.join(process.cwd(), "uploads");
}

/**
 * Filenames we write ourselves: uuid-ish stem + image extension. Nothing else is ever read or deleted.
 * svg: vector model outputs in generated-images (uploads validate their own, narrower list).
 */
export const SAFE_IMAGE_FILENAME = /^[\w-]+\.(png|jpe?g|webp|gif|avif|svg)$/i;

/**
 * Resolve a bare filename inside `dir`, or return null if it is not a safe
 * image filename or would escape the directory.
 */
export function resolveInside(dir: string, filename: string): string | null {
	const base = path.basename(filename);
	if (base !== filename || !SAFE_IMAGE_FILENAME.test(base)) return null;
	const root = path.resolve(dir);
	const full = path.resolve(root, base);
	if (path.dirname(full) !== root) return null;
	return full;
}

/** Best-effort unlink of a file we own; never throws. */
export function unlinkInside(dir: string, filename: string | null | undefined): void {
	if (!filename) return;
	const full = resolveInside(dir, filename);
	if (!full) return;
	try {
		if (fs.existsSync(full)) fs.unlinkSync(full);
	} catch (err) {
		console.error("Failed to delete file:", full, err);
	}
}

/**
 * Delete every image file belonging to a generation row: the primary image plus
 * any extra grid images recorded in parameters.images[].path.
 */
export function deleteGenerationFiles(imagePath: string | null | undefined, parametersJson: string | null | undefined): void {
	const dir = getImagesDir();
	const names = new Set<string>();
	if (imagePath) names.add(imagePath);
	if (parametersJson) {
		try {
			const params = JSON.parse(parametersJson) as { images?: { path?: unknown }[] };
			for (const img of params.images ?? []) {
				if (typeof img?.path === "string") names.add(img.path);
			}
		} catch {
			// Malformed parameters JSON: only the primary file can be removed.
		}
	}
	for (const name of names) unlinkInside(dir, name);
}
