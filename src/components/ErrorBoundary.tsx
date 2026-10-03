import { Component, type ErrorInfo, type ReactNode } from "react";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";

interface State {
	error: Error | null;
}

/**
 * Last line of defence for a render crash anywhere in the app. Shows a plain
 * recovery screen instead of a blank page. It deliberately avoids the router
 * and auth context, which may be what failed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("Unhandled render error", error, info.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;

		return (
			<main className="flex min-h-dvh flex-col items-start justify-center gap-6 bg-background px-4 py-16 sm:items-center sm:text-center">
				<Laurel className="size-12 opacity-60" />
				<div className="max-w-md space-y-2">
					<h1 className="text-2xl font-semibold">This page stopped working</h1>
					<p className="text-muted-foreground">
						Something went wrong while showing this screen. Your images and credits are safe. Reload
						to try again.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button type="button" variant="outline" onClick={() => window.location.reload()}>
						Reload
					</Button>
					<Button type="button" variant="ghost" onClick={() => window.location.assign("/")}>
						Go to ollo
					</Button>
				</div>
			</main>
		);
	}
}
