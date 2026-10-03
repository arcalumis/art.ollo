import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "@/components/brand/Laurel";
import { cn } from "@/lib/utils";

/**
 * The bronze crow behind the sign-in screens (/login, link verification,
 * password reset).
 *
 * The photo is mirrored so the crow sits on the right and looks toward the
 * form. Desktop: the photo covers the screen and the form card sits in the
 * empty dark on the left. Phone: the photo is a full-width header at its own
 * aspect ratio (the whole crow, never a cropped sliver) and the card overlaps
 * its empty lower edge.
 */
export function AuthBackdrop({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className="relative flex min-h-dvh flex-col bg-background lg:flex-row lg:items-center">
			<div className="finish-night relative bg-background lg:absolute lg:inset-0">
				<img
					src="/showcase/crow-hero.webp"
					alt=""
					width={1232}
					height={1248}
					className="block aspect-[1232/1248] w-full -scale-x-100 object-cover lg:aspect-auto lg:h-full lg:object-[50%_22%]"
				/>
				<Link
					to="/"
					className="absolute top-4 left-4 inline-flex min-h-10 items-center rounded-lg px-1 lg:top-6 lg:left-8"
					aria-label="ollo home"
				>
					<Wordmark />
				</Link>
			</div>
			<main
				className={cn(
					"relative z-10 mx-4 -mt-24 mb-8 rounded-2xl border border-border bg-card p-6 sm:mx-auto sm:w-full sm:max-w-md sm:p-8 lg:my-12 lg:ml-[max(2rem,8vw)]",
					className,
				)}
			>
				{children}
			</main>
		</div>
	);
}
