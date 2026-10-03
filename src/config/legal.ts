/**
 * The facts the Terms and Privacy pages depend on. Defined once, here.
 *
 * Change effectiveDate whenever the Terms or Privacy Policy text changes.
 */
export const LEGAL = {
	/** The company or person that operates ollo, e.g. "Example LLC". */
	entity: "Matahari Development, LLC",
	/** Where legal, privacy and billing questions go. */
	contactEmail: "support@matahari.dev",
	/** When the current Terms and Privacy Policy took effect, e.g. "1 November 2026". */
	effectiveDate: "3 October 2026",
} as const;
