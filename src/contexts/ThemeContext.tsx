import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * ollo has one identity in two finishes: Night (dark, the default) and
 * Plaster (light). "system" follows the OS setting. The palette itself lives
 * in src/index.css; this only records an explicit choice as data-theme on
 * <html>, which the CSS tokens key off.
 */
export type Finish = "system" | "night" | "plaster";

interface ThemeContextValue {
	finish: Finish;
	/** The finish actually on screen once "system" is resolved. */
	resolved: "night" | "plaster";
	setFinish: (finish: Finish) => void;
}

const STORAGE_KEY = "ollo-finish";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredFinish(): Finish {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "night" || stored === "plaster" || stored === "system") return stored;
	} catch {
		// Storage can be unavailable (private mode); fall back to the default.
	}
	return "system";
}

const lightQuery = () => window.matchMedia("(prefers-color-scheme: light)");

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [finish, setFinishState] = useState<Finish>(readStoredFinish);
	const [systemIsLight, setSystemIsLight] = useState(() => lightQuery().matches);

	useEffect(() => {
		const query = lightQuery();
		const onChange = () => setSystemIsLight(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		const root = document.documentElement;
		if (finish === "system") root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", finish === "plaster" ? "light" : "dark");
		// Earlier versions wrote theme colours as inline styles and a CRT class.
		for (const name of ["--bg-primary", "--bg-secondary", "--bg-tertiary", "--accent", "--accent-alt", "--text-primary", "--text-secondary", "--border", "--card-bg", "--card-border"]) {
			root.style.removeProperty(name);
		}
		root.classList.remove("scanlines");
	}, [finish]);

	const setFinish = useCallback((next: Finish) => {
		setFinishState(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
			localStorage.removeItem("theme");
		} catch {
			// Not persisted; the choice still applies for this visit.
		}
	}, []);

	const resolved = finish === "system" ? (systemIsLight ? "plaster" : "night") : finish;

	return <ThemeContext.Provider value={{ finish, resolved, setFinish }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
