/**
 * The facts the Terms and Privacy pages depend on. Defined once, here.
 *
 * The owner fills these in before launch; the `{{…}}` placeholders render
 * as-is until then so a missing value is obvious on the page.
 */
export const LEGAL = {
	/** The company or person that operates ollo, e.g. "Example LLC". */
	entity: "{{LEGAL_ENTITY}}",
	/** Where legal, privacy and billing questions go. */
	contactEmail: "{{CONTACT_EMAIL}}",
	/** When the current Terms and Privacy Policy took effect, e.g. "1 November 2026". */
	effectiveDate: "{{EFFECTIVE_DATE}}",
} as const;
