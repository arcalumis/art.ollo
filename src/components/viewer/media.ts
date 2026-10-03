import { modelName } from "@/components/billing/plans";
import { API_BASE } from "@/config";
import type { Generation, Upload } from "@/types";
import { toast } from "sonner";

/** One image the viewer can show: a generated image (one of a set) or an upload. */
export interface ViewerImage {
	/** Stable key: generation id, plus the grid image id for sets. */
	key: string;
	/** Relative URL, e.g. /images/abc.png */
	url: string;
	kind: "generation" | "upload";
	generation?: Generation;
	upload?: Upload;
	/** Position within its generation's set (4-up grids), and the set size. */
	setIndex?: number;
	setSize?: number;
}

/** Mirrors TRASH_RETENTION_DAYS in server/services/cleanup.ts (the purge job). */
export const TRASH_RETENTION_DAYS = 30;

/** Things the viewer, gallery and series can do; the app wires the ones it supports. */
export type ImageTool = "upscale" | "remove-background";

export interface ImageActionCosts {
	vary?: number;
	upscale?: number;
	"remove-background"?: number;
}

export function absoluteUrl(url: string): string {
	return /^https?:/.test(url) ? url : `${API_BASE}${url}`;
}

/** Every image of a generation, in order (4-up grids carry them in `images`). */
export function imagesOf(gen: Generation): ViewerImage[] {
	const set = gen.images && gen.images.length > 1 ? gen.images : null;
	if (set) {
		return set.map((img, i) => ({
			key: `${gen.id}:${img.id}`,
			url: img.url,
			kind: "generation" as const,
			generation: gen,
			setIndex: i,
			setSize: set.length,
		}));
	}
	return gen.imageUrl
		? [{ key: gen.id, url: gen.imageUrl, kind: "generation", generation: gen }]
		: [];
}

export function uploadImage(upload: Upload): ViewerImage {
	return { key: `upload:${upload.id}`, url: upload.imageUrl, kind: "upload", upload };
}

/** The generation as the app's legacy handlers expect it: imageUrl set to the chosen image. */
export function asGeneration(image: ViewerImage): Generation | null {
	return image.generation ? { ...image.generation, imageUrl: image.url } : null;
}

export function promptOf(image: ViewerImage): string {
	return image.generation?.prompt ?? image.upload?.originalName ?? "";
}

/** Credits a generation charged (stored in parameters since Phase 2). */
export function creditsOf(gen: Generation | undefined): number | undefined {
	const value = gen?.parameters?.creditsCharged;
	return typeof value === "number" ? value : undefined;
}

/** "4:3" -> "4 / 3" for CSS aspect-ratio; anything else (match input, missing) -> undefined. */
export function cssAspect(ratio: unknown): string | undefined {
	if (typeof ratio !== "string") return undefined;
	const m = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
	return m ? `${m[1]} / ${m[2]}` : undefined;
}

/** SQLite timestamps come without a zone; they are UTC. */
export function parseDate(value: string | undefined | null): Date | null {
	if (!value) return null;
	const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	year: "numeric",
});
export function formatDate(value: string | undefined | null): string {
	const d = parseDate(value);
	return d ? dateFmt.format(d) : "";
}

/** A short title from a prompt: its first clause, capped near 48 characters. */
export function shortTitle(prompt: string): string {
	const clean = prompt.replace(/\s+/g, " ").trim();
	if (!clean) return "Untitled";
	const clause = clean.split(/[.,;:!?\n]/)[0] || clean;
	const title = clause.length > 48 ? `${clause.slice(0, 47).replace(/\s+\S*$/, "")}…` : clause;
	return title.charAt(0).toUpperCase() + title.slice(1);
}

export function labelFor(image: ViewerImage): string {
	if (image.kind === "upload") return image.upload?.originalName ?? "Upload";
	return image.generation ? modelName(image.generation.model) : "";
}

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\w\s-]/g, "")
			.trim()
			.split(/\s+/)
			.slice(0, 6)
			.join("-")
			.slice(0, 48) || "image"
	);
}

/** ollo-bronze-crow-on-a-plinth-1a2b3c4d.png */
export function downloadName(image: ViewerImage): string {
	const ext = image.url.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)?.[1]?.toLowerCase() ?? "png";
	if (image.kind === "upload" && image.upload) {
		const base = image.upload.originalName.replace(/\.[^.]+$/, "");
		return `${slugify(base)}.${ext}`;
	}
	const id = (image.generation?.id ?? "").slice(0, 8);
	const n = image.setSize ? `-${(image.setIndex ?? 0) + 1}` : "";
	return `ollo-${slugify(promptOf(image))}${id ? `-${id}` : ""}${n}.${ext}`;
}

/** A real file download with a sensible name (falls back to opening the image). */
export async function downloadImage(image: ViewerImage): Promise<void> {
	const href = absoluteUrl(image.url);
	try {
		const res = await fetch(href);
		if (!res.ok) throw new Error(String(res.status));
		const blob = await res.blob();
		const objectUrl = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = objectUrl;
		a.download = downloadName(image);
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
	} catch {
		// Cross-origin in dev, or the network dropped: let the browser handle it.
		window.open(href, "_blank", "noopener");
	}
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

export async function copyPrompt(prompt: string): Promise<void> {
	if (await copyText(prompt)) toast.success("Prompt copied");
	else toast.error("Couldn't reach the clipboard. Select the prompt and copy it instead.");
}

async function revokeShare(token: string, generationId: string): Promise<void> {
	const res = await fetch(`${API_BASE}/api/share/${generationId}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	}).catch(() => null);
	if (res?.ok) toast.success("Share link turned off");
	else toast.error("Couldn't turn the link off. Try again.");
}

/** Create (or reuse) the public link, copy it, and offer to turn it off again. */
export async function copyShareLink(token: string | null, generationId: string): Promise<void> {
	if (!token) return;
	const res = await fetch(`${API_BASE}/api/share/${generationId}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	}).catch(() => null);
	if (!res?.ok) {
		const code = res ? ((await res.json().catch(() => ({}))) as { code?: string }).code : undefined;
		toast.error(
			code === "IN_TRASH"
				? "Restore this image from Trash before sharing it."
				: "Couldn't make a share link. Try again.",
		);
		return;
	}
	const { path } = (await res.json()) as { path: string };
	const url = `${window.location.origin}${path}`;
	const copied = await copyText(url);
	toast.success(copied ? "Share link copied" : url, {
		description: copied
			? "Anyone with the link can see this image and its prompt."
			: "Copy this link to share the image.",
		action: { label: "Turn off", onClick: () => void revokeShare(token, generationId) },
		duration: 8000,
	});
}

/** Move to Trash with an Undo in the toast. */
export async function trashWithUndo(
	id: string,
	onTrash: (id: string) => unknown,
	onRestore?: (id: string) => unknown,
): Promise<void> {
	await onTrash(id);
	toast("Moved to Trash", {
		action: onRestore
			? {
					label: "Undo",
					onClick: () => {
						void Promise.resolve(onRestore(id)).then(() => toast.success("Restored"));
					},
				}
			: undefined,
		duration: 6000,
	});
}
