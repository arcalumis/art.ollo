import { type ReactNode, useEffect } from "react";
import { LEGAL } from "../../config/legal";
import { SiteFooter, SiteHeader } from "./SiteChrome";

/**
 * Long-form layout for Terms and Privacy: one Marcellus title, then a 65ch
 * column of plain sans text. Section headings are numbered because the
 * documents refer to their own sections.
 */
export function LegalPage({
	title,
	intro,
	children,
}: { title: string; intro: ReactNode; children: ReactNode }) {
	useEffect(() => {
		document.title = `${title} | ollo`;
		window.scrollTo(0, 0);
	}, [title]);

	return (
		<div className="flex min-h-dvh flex-col bg-background">
			<SiteHeader />
			<main className="mx-auto w-full max-w-[65ch] flex-1 px-4 pt-10 pb-20 sm:pt-16">
				<h1 className="font-display text-4xl leading-tight sm:text-5xl">{title}</h1>
				<p className="mt-3 text-sm text-muted-foreground">Effective {LEGAL.effectiveDate}</p>
				<div className="mt-8 text-[1.0625rem] leading-relaxed text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-12 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mt-2 [&_p]:mt-4 [&_strong]:font-semibold [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:marker:text-muted-foreground">
					<div className="text-lg text-muted-foreground [&_p]:mt-0">{intro}</div>
					{children}
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}

/** The contact address as a mailto link. */
export function ContactEmail() {
	return <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>;
}
