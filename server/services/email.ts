import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const APP_URL = process.env.APP_URL || "http://localhost:5173";
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

export async function sendWelcomeEmail(
	email: string,
	username: string,
	password: string,
): Promise<{ success: boolean; error?: string }> {
	if (!process.env.RESEND_API_KEY) {
		console.warn("RESEND_API_KEY not configured, skipping email");
		return { success: false, error: "Email not configured" };
	}

	try {
		const { error } = await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: "Welcome to ollo.art - Your Account Details",
			html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to ollo.art!</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
    <p style="font-size: 16px;">Hi <strong>${username}</strong>,</p>

    <p style="font-size: 16px;">Your account has been created. Here are your login credentials:</p>

    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0 0 10px 0;"><strong>Username:</strong> ${username}</p>
      <p style="margin: 0;"><strong>Password:</strong> <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${password}</code></p>
    </div>

    <p style="font-size: 14px; color: #6b7280;">We recommend changing your password after your first login.</p>

    <a href="${APP_URL}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; margin: 20px 0;">
      Log In Now
    </a>

    <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
      If you didn't expect this email, please ignore it or contact support.
    </p>
  </div>
</body>
</html>
`,
		});

		if (error) {
			console.error("Failed to send welcome email:", error);
			return { success: false, error: error.message };
		}

		return { success: true };
	} catch (err) {
		console.error("Failed to send welcome email:", err);
		return { success: false, error: String(err) };
	}
}

export async function sendMagicLinkEmail(
	email: string,
	username: string,
	token: string,
	rememberMe: boolean,
): Promise<{ success: boolean; error?: string }> {
	if (!process.env.RESEND_API_KEY) {
		console.warn("RESEND_API_KEY not configured, skipping email");
		console.log(
			`[DEV] Magic link: ${APP_URL}/auth/magic-link?token=${token}&rememberMe=${rememberMe}`,
		);
		return { success: true };
	}

	try {
		const magicLinkUrl = `${APP_URL}/auth/magic-link?token=${token}&rememberMe=${rememberMe}`;

		const { error } = await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: "Your Login Link for ollo.art",
			html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Sign In to ollo.art</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
    <p style="font-size: 16px;">Hi <strong>${username}</strong>,</p>

    <p style="font-size: 16px;">Click the button below to sign in to your account. This link will expire in 15 minutes.</p>

    <a href="${magicLinkUrl}" style="display: inline-block; background: linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%); color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 600; margin: 20px 0; font-size: 16px;">
      Sign In Now
    </a>

    <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
      Or copy and paste this link into your browser:
    </p>
    <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">
      ${magicLinkUrl}
    </p>

    <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
      If you didn't request this link, you can safely ignore this email.
    </p>
  </div>
</body>
</html>
`,
		});

		if (error) {
			console.error("Failed to send magic link email:", error);
			return { success: false, error: error.message };
		}

		return { success: true };
	} catch (err) {
		console.error("Failed to send magic link email:", err);
		return { success: false, error: String(err) };
	}
}

export async function sendPasswordResetEmail(
	email: string,
	username: string,
	token: string,
): Promise<{ success: boolean; error?: string }> {
	if (!process.env.RESEND_API_KEY) {
		console.warn("RESEND_API_KEY not configured, skipping email");
		console.log(`[DEV] Password reset link: ${APP_URL}/auth/reset-password?token=${token}`);
		return { success: true };
	}

	try {
		const resetUrl = `${APP_URL}/auth/reset-password?token=${token}`;

		const { error } = await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: "Reset Your ollo.art Password",
			html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #f43f5e 0%, #ec4899 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Reset Your Password</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
    <p style="font-size: 16px;">Hi <strong>${username}</strong>,</p>

    <p style="font-size: 16px;">We received a request to reset your password. Click the button below to choose a new password. This link will expire in 1 hour.</p>

    <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #f43f5e 0%, #ec4899 100%); color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 600; margin: 20px 0; font-size: 16px;">
      Reset Password
    </a>

    <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
      Or copy and paste this link into your browser:
    </p>
    <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">
      ${resetUrl}
    </p>

    <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
      If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.
    </p>
  </div>
</body>
</html>
`,
		});

		if (error) {
			console.error("Failed to send password reset email:", error);
			return { success: false, error: error.message };
		}

		return { success: true };
	} catch (err) {
		console.error("Failed to send password reset email:", err);
		return { success: false, error: String(err) };
	}
}
