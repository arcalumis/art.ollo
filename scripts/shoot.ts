// Screenshot key routes at phone and desktop widths for visual self-review.
//
//   bun scripts/shoot.ts [baseUrl] [outDir] [route ...]
//
// Defaults to the local dev server and the main public + app routes. Pass
// OLLO_TOKEN to capture signed-in routes (it is written to localStorage the
// same way AuthContext stores it).
import { chromium } from "@playwright/test";

const [baseUrl = "http://localhost:5173", outDir = "shots", ...routeArgs] = process.argv.slice(2);
const routes = routeArgs.length ? routeArgs : ["/", "/pricing", "/login", "/create", "/gallery", "/billing"];
const viewports = [
	{ name: "phone", width: 390, height: 844 },
	{ name: "desktop", width: 1440, height: 900 },
];

const browser = await chromium.launch();
for (const vp of viewports) {
	const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
	const token = process.env.OLLO_TOKEN;
	if (token) await context.addInitScript((t) => localStorage.setItem("token", t), token);
	const page = await context.newPage();
	for (const route of routes) {
		await page.goto(baseUrl + route, { waitUntil: "networkidle" }).catch(() => {});
		const file = `${outDir}/${vp.name}${route === "/" ? "-home" : route.replaceAll("/", "-")}.png`;
		await page.screenshot({ path: file, fullPage: true });
		console.log(file);
	}
	await context.close();
}
await browser.close();
