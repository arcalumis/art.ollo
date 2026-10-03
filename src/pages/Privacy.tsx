import { Link } from "react-router-dom";
import { ContactEmail, LegalPage } from "../components/site/LegalPage";
import { LEGAL } from "../config/legal";

export function Privacy() {
	return (
		<LegalPage
			title="Privacy Policy"
			intro={
				<p>
					This policy explains what {LEGAL.entity} collects when you use ollo, why, who else sees
					it, and what you can ask us to do with it. We collect what we need to run the service and
					bill for it, and nothing for advertising.
				</p>
			}
		>
			<h2>1. What we collect</h2>
			<ul>
				<li>
					<strong>Account details:</strong> your email address, username, and a hashed password if
					you set one. If you sign in with a Solana wallet, its public address.
				</li>
				<li>
					<strong>What you make:</strong> your prompts, the images you upload as references, the
					images ollo generates, and settings such as model and aspect ratio. Threads you create and
					their titles.
				</li>
				<li>
					<strong>Billing records:</strong> your plan, credit balance and history, and payments.
					Card payments are processed by Stripe; we receive a customer reference, amounts and
					status, never your full card number. For SOL payments we record the wallet address and
					transaction signature, which are public on the Solana network.
				</li>
				<li>
					<strong>Technical data:</strong> IP addresses and basic request logs, used for security,
					rate limiting and preventing abuse of sign-in emails.
				</li>
				<li>
					<strong>Your own API key</strong>, if you add one to use your own Replicate account. It is
					stored encrypted.
				</li>
			</ul>
			<p>
				ollo keeps you signed in with a token stored in your browser's local storage, and remembers
				preferences such as the light or dark finish the same way. We don't use advertising or
				analytics cookies. Stripe's checkout pages set their own cookies to process payments and
				prevent fraud.
			</p>

			<h2>2. How we use it</h2>
			<ul>
				<li>To generate your images and keep your series, gallery and history available to you.</li>
				<li>
					To sign you in, send sign-in and password reset emails, and keep your account secure.
				</li>
				<li>
					To charge for plans and credits, keep accurate billing records, and meet tax and
					accounting duties.
				</li>
				<li>
					To detect and stop abuse, including content our <Link to="/terms">Terms</Link> prohibit,
					and to comply with the law.
				</li>
				<li>
					To understand costs and fix problems, using aggregate figures such as how often each model
					is used.
				</li>
			</ul>
			<p>
				We don't sell your personal information, share it for advertising, or use your prompts and
				images to train AI models.
			</p>

			<h2>3. Who else processes it</h2>
			<p>We share data only with the services that run ollo for us, and only what each needs:</p>
			<ul>
				<li>
					<strong>Replicate</strong> runs the image models. It receives your prompt and any
					reference images for each generation and returns the result.
				</li>
				<li>
					<strong>Stripe</strong> processes card payments and subscriptions and receives your email
					and payment details.
				</li>
				<li>
					<strong>Resend</strong> delivers sign-in and account emails and receives your email
					address.
				</li>
				<li>
					<strong>Solana network providers</strong> relay wallet transactions. Transactions on
					Solana are public by design.
				</li>
				<li>Our hosting provider stores the database and image files.</li>
			</ul>
			<p>
				We may also disclose information when the law requires it, to protect people from harm, or
				as part of a sale or merger of ollo, in which case this policy continues to apply to your
				data. We report child sexual abuse material to the National Center for Missing &amp;
				Exploited Children as US law requires.
			</p>

			<h2>4. How long we keep it</h2>
			<ul>
				<li>Your prompts and images stay in your account until you delete them or your account.</li>
				<li>
					When you empty an image from Trash, its file is permanently deleted within about an hour.
					We keep a record of the generation (prompt, model, cost and date) for billing and abuse
					prevention.
				</li>
				<li>
					Payment and credit records are kept for as long as tax and accounting rules require,
					usually up to 7 years, even after an account is deleted.
				</li>
				<li>Security logs are kept for a short period and then deleted.</li>
			</ul>

			<h2>5. Your choices and rights</h2>
			<p>
				You can see, download and delete your images in ollo at any time. To get a copy of your
				data, correct it, or delete your account, email <ContactEmail /> from the address on the
				account. We'll reply within 30 days. Depending on where you live, including California and
				the EU or UK, you may have further rights, such as to object to certain uses or to complain
				to a regulator. We won't treat you differently for using them.
			</p>

			<h2>6. Security</h2>
			<p>
				Connections to ollo are encrypted, passwords are hashed, sign-in links expire after 15
				minutes and work once, and stored API keys are encrypted. No system is perfectly secure; if
				a breach affects your data, we'll tell you as the law requires.
			</p>

			<h2>7. Children</h2>
			<p>
				ollo is for adults. We don't knowingly collect data from anyone under 18. If you believe a
				child has an account, email <ContactEmail /> and we'll remove it.
			</p>

			<h2>8. Where data is processed</h2>
			<p>
				ollo is run from the United States, and our providers may process data in the US and other
				countries. By using ollo, your data will be transferred to and processed in the US.
			</p>

			<h2>9. Changes and contact</h2>
			<p>
				If we change this policy in a significant way, we'll email you or show a notice in ollo
				first. Questions or requests: <ContactEmail />.
			</p>
		</LegalPage>
	);
}
