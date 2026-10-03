import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** "Remember me for 30 days": issues a longer-lived session on sign-in. */
export function RememberMe({
	id,
	checked,
	onChange,
}: {
	id: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label
			htmlFor={id}
			className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-muted-foreground"
		>
			<input
				id={id}
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="size-4 accent-verdigris"
			/>
			Remember me for 30 days
		</label>
	);
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
	return (
		<label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-foreground">
			{children}
		</label>
	);
}

/** Inline error for a form step. Announced to screen readers when it appears. */
export function FormError({ message }: { message: string }) {
	if (!message) return null;
	return (
		<p role="alert" className="text-sm text-destructive">
			{message}
		</p>
	);
}

/** Quiet text button for secondary paths ("Use a different email"). */
export function QuietLink({
	onClick,
	children,
	disabled,
	className,
}: {
	onClick: () => void;
	children: ReactNode;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"inline-flex min-h-10 items-center rounded-lg px-1 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-60",
				className,
			)}
		>
			{children}
		</button>
	);
}

/** Heading block shared by every step, so the flow reads as one surface. */
export function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="space-y-1.5">
			<h2 className="text-xl font-semibold text-foreground">{title}</h2>
			{children && <p className="text-sm text-muted-foreground">{children}</p>}
		</div>
	);
}
