/** The signed-in app's routes, in one place. */

export type LibraryView = "all" | "archive" | "trash";

export const CREATE_PATH = "/create";
export const GALLERY_PATH = "/gallery";
export const BILLING_PATH = "/billing";
export const SETTINGS_PATH = "/settings";

export const seriesPath = (threadId: string) => `${CREATE_PATH}/${encodeURIComponent(threadId)}`;

export const libraryPath = (view: LibraryView) =>
	view === "all" ? GALLERY_PATH : `${GALLERY_PATH}/${view}`;

export const LIBRARY_TITLES: Record<LibraryView, string> = {
	all: "All images",
	archive: "Archive",
	trash: "Trash",
};

/** Which signed-in screen a pathname shows; null outside the app shell. */
export type AppView =
	| { kind: "create"; threadId?: string }
	| { kind: "gallery"; library: LibraryView }
	| { kind: "billing" }
	| { kind: "settings" };

export function viewFromPath(pathname: string): AppView | null {
	const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
	const [head, sub, ...rest] = parts;
	if (rest.length) return null;
	if (head === "create")
		return sub ? { kind: "create", threadId: decodeURIComponent(sub) } : { kind: "create" };
	if (head === "gallery") {
		if (!sub) return { kind: "gallery", library: "all" };
		if (sub === "archive" || sub === "trash") return { kind: "gallery", library: sub };
		return null;
	}
	if (head === "billing" && !sub) return { kind: "billing" };
	if (head === "settings" && !sub) return { kind: "settings" };
	return null;
}

// Where a signed-out visitor was headed, so signing in lands them there.
const RETURN_KEY = "ollo:returnTo";

export function rememberReturnPath(path: string): void {
	try {
		sessionStorage.setItem(RETURN_KEY, path);
	} catch {
		// Storage can be unavailable (private mode); landing on /create is fine.
	}
}

/** The remembered app path, or /create. Only app paths are honoured. Doesn't clear it (render-safe). */
export function peekReturnPath(): string {
	let path: string | null = null;
	try {
		path = sessionStorage.getItem(RETURN_KEY);
	} catch {
		path = null;
	}
	return path && viewFromPath(path.split(/[?#]/)[0]) ? path : CREATE_PATH;
}

export function clearReturnPath(): void {
	try {
		sessionStorage.removeItem(RETURN_KEY);
	} catch {
		// Nothing stored, nothing to clear.
	}
}
