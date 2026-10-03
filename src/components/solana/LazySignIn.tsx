import { Skeleton } from "@/components/ui/skeleton";
import { type ComponentProps, lazy } from "react";
import { SolanaBoundary } from "./SolanaBoundary";

// The sign-in flow includes wallet sign-in, so it brings the wallet libraries with it.
const SignInFlow = lazy(() =>
	import("@/components/auth/SignIn").then((m) => ({ default: m.SignIn })),
);

/** Holds the sign-in form's place while it loads. */
export function SignInSkeleton() {
	return (
		<div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading sign-in">
			<Skeleton className="h-7 w-3/4" />
			<Skeleton className="h-4 w-full" />
			<Skeleton className="mt-2 h-10 w-full rounded-lg" />
			<Skeleton className="h-10 w-full rounded-lg" />
		</div>
	);
}

/** The sign-in flow, loaded on demand with the wallet provider around it. */
export function SignIn(props: ComponentProps<typeof SignInFlow>) {
	return (
		<SolanaBoundary fallback={<SignInSkeleton />}>
			<SignInFlow {...props} />
		</SolanaBoundary>
	);
}
