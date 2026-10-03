import { Link } from "react-router-dom";
import { ContactEmail, LegalPage } from "../components/site/LegalPage";
import { LEGAL } from "../config/legal";

export function Terms() {
	return (
		<LegalPage
			title="Terms of Service"
			intro={
				<p>
					These terms are the agreement between you and {LEGAL.entity} ("we", "us") for using ollo,
					the image generator at ollo.art. We've kept them as plain as we can. By creating an
					account or using ollo, you agree to them.
				</p>
			}
		>
			<h2>1. Your account</h2>
			<p>
				You need to be at least 18 years old, or the age of majority where you live, to use ollo.
				You sign in with an emailed link, a password, or a Solana wallet. Keep access to that email,
				password or wallet secure: anything done through your account is your responsibility. One
				person per account; don't share or sell access.
			</p>

			<h2>2. Credits</h2>
			<p>
				Credits are how you pay for generations. Each model has a credit cost, shown on the Generate
				button before you start. Credits are taken when a generation starts. If it fails on our side
				or at our image provider, the credits are returned to your balance.
			</p>
			<ul>
				<li>New accounts get a small number of free credits to try ollo.</li>
				<li>Plans add credits on a schedule. Top-ups add credits once.</li>
				<li>
					Credits have no cash value, can't be transferred or exchanged for money, and are used only
					on ollo. We may set expiry rules for plan credits, which we'll show on the{" "}
					<Link to="/pricing">pricing page</Link>.
				</li>
				<li>
					We may change model credit costs. A change never affects a generation you have already
					started.
				</li>
			</ul>

			<h2>3. Plans and payment</h2>
			<p>
				Prices are in US dollars. You can pay by card through Stripe or in SOL (Solana) from your
				own wallet. For SOL, the amount is calculated from the dollar price and the SOL exchange
				rate when you start the payment.
			</p>
			<ul>
				<li>
					<strong>Subscriptions</strong> paid by card renew automatically each billing period until
					you cancel. You can cancel any time from Billing; you keep your plan until the end of the
					period you've paid for.
				</li>
				<li>
					<strong>Plans paid in SOL</strong> last for the period you bought and don't renew
					automatically.
				</li>
				<li>
					<strong>Crypto payments</strong> are final once confirmed on the Solana network. Sending
					the wrong amount or to the wrong address can't be reversed by us; always pay from the
					screen ollo shows you.
				</li>
				<li>
					You're responsible for any taxes that apply to your purchase, unless we collect them at
					checkout.
				</li>
			</ul>

			<h2>4. Refunds</h2>
			<p>
				Because credits are spent on paid compute the moment you generate, we don't refund used
				credits or the unused part of a billing period. If you were charged by mistake, charged
				twice, or a purchase didn't add the credits it should have, email <ContactEmail /> within 30
				days and we'll put it right. This doesn't limit any refund rights you have under the law
				where you live.
			</p>

			<h2>5. What you can't make or do</h2>
			<p>You may not use ollo to create, upload, or share:</p>
			<ul>
				<li>
					<strong>Sexual content involving minors</strong>, or anything that sexualizes children, in
					any style, real or fictional. We remove it, close the account, and report it to the
					National Center for Missing &amp; Exploited Children and law enforcement.
				</li>
				<li>
					<strong>Sexual or intimate imagery of a real person</strong> without their consent, or
					images that put a real person in a false, degrading or compromising situation.
				</li>
				<li>
					Images meant to deceive people into thinking they are real, such as fake news photos or
					impersonation.
				</li>
				<li>Content that is illegal where you live or in the United States.</li>
				<li>
					Harassment, threats, or content that promotes violence or hatred against people for who
					they are.
				</li>
				<li>
					Content that infringes someone else's copyright, trademark, or privacy, including uploads
					you don't have the rights to.
				</li>
			</ul>
			<p>
				You also may not try to get around credit costs, limits or safety filters, access other
				people's accounts or data, overload or probe the service, scrape it, or resell access to it.
			</p>
			<p>
				Our image provider runs its own safety filters, and some prompts will be refused. We may
				review prompts and images when we need to investigate abuse, enforce these terms, or comply
				with the law.
			</p>

			<h2>6. Your prompts and images</h2>
			<p>
				You keep whatever rights you have in the prompts you write, the images you upload, and the
				images you generate. You give us permission to store, process and show them to you as needed
				to run ollo, including sending them to the providers that generate images for us. That
				permission ends when you delete them, except for copies we must keep for the reasons in our{" "}
				<Link to="/privacy">Privacy Policy</Link>.
			</p>
			<p>
				AI-generated images may resemble other images, and similar prompts can produce similar
				results for other people. We can't promise that a generated image is unique or that it can
				be protected by copyright where you live. You are responsible for how you use what you make.
			</p>

			<h2>7. Services we rely on</h2>
			<p>
				Images are generated by models hosted on Replicate. Card payments are handled by Stripe and
				we never see your full card number. Sign-in emails are sent with Resend. Models and
				providers may change, and a model may be unavailable from time to time.
			</p>

			<h2>8. Ending your account</h2>
			<p>
				You can stop using ollo whenever you like. To delete your account and its images, email{" "}
				<ContactEmail /> from the address on the account. Cancel any card subscription first so you
				aren't charged again.
			</p>
			<p>
				We may suspend or close an account that breaks these terms, puts other people at risk, or is
				used for fraud. Where we can, we'll tell you why. If we close an account for breaking these
				terms, its unused credits and the rest of its plan period are forfeited. If we shut ollo
				down, we'll give at least 30 days' notice and refund the unused part of prepaid plans.
			</p>

			<h2>9. No guarantees</h2>
			<p>
				ollo is provided "as is". We work to keep it running and your images safe, but we don't
				promise it will always be available, error-free, or that every generation will match what
				you asked for. Keep your own copies of images that matter to you.
			</p>

			<h2>10. Limits on liability</h2>
			<p>
				To the extent the law allows, we aren't liable for indirect or consequential losses, such as
				lost profits or data, and our total liability for any claim about ollo is limited to the
				amount you paid us in the 12 months before the claim. Some places don't allow these limits,
				so they may not apply to you.
			</p>

			<h2>11. Changes to these terms</h2>
			<p>
				We may update these terms. If a change is significant, we'll email you or show a notice in
				ollo before it takes effect. Continuing to use ollo after that means you accept the new
				terms.
			</p>

			<h2>12. Law and contact</h2>
			<p>
				These terms are governed by the laws of the United States and of the state in which{" "}
				{LEGAL.entity} is organized, without regard to conflict-of-law rules. Questions about these
				terms: <ContactEmail />.
			</p>
		</LegalPage>
	);
}
