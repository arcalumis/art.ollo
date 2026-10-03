/**
 * A prompt typed on the landing page before the visitor had an account.
 *
 * The landing page saves it, the visitor signs up (often by opening the magic
 * link in another tab), and the app picks it up once, then clears it.
 */

const KEY = "ollo-pending-prompt";
/** Older than this and the visitor has moved on; don't surprise them with it. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PendingPrompt {
	prompt: string;
	aspectRatio: string;
	model: string;
}

interface Stored extends PendingPrompt {
	savedAt: number;
}

export function savePendingPrompt(pending: PendingPrompt): void {
	try {
		const stored: Stored = { ...pending, savedAt: Date.now() };
		localStorage.setItem(KEY, JSON.stringify(stored));
	} catch {
		// Storage blocked (private mode): sign-up still works, the prompt just isn't carried over.
	}
}

export function readPendingPrompt(): PendingPrompt | null {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const data = JSON.parse(raw) as Partial<Stored>;
		const valid =
			typeof data.prompt === "string" &&
			data.prompt.trim() !== "" &&
			typeof data.aspectRatio === "string" &&
			typeof data.model === "string" &&
			typeof data.savedAt === "number" &&
			Date.now() - data.savedAt < MAX_AGE_MS;
		if (!valid) {
			localStorage.removeItem(KEY);
			return null;
		}
		return {
			prompt: data.prompt as string,
			aspectRatio: data.aspectRatio as string,
			model: data.model as string,
		};
	} catch {
		return null;
	}
}

export function clearPendingPrompt(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// nothing to clear
	}
}

/** Read the pending prompt and clear it, so it is used exactly once. */
export function takePendingPrompt(): PendingPrompt | null {
	const pending = readPendingPrompt();
	if (pending) clearPendingPrompt();
	return pending;
}

/**
 * Put text into the app's prompt bar without starting a generation.
 *
 * CreationPanel keeps its prompt in local state and has no prop for an initial
 * value, so this writes through the textarea's native value setter and fires
 * an input event, which React treats as typing. When CreationPanel grows an
 * `initialPrompt` prop, replace calls to this with that.
 */
export function fillPromptBar(text: string): boolean {
	const el = document.querySelector<HTMLTextAreaElement>("main form textarea");
	if (!el) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) return false;
	setter.call(el, text);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}
