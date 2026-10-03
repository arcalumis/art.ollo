import "./inject-bun-fix";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSafeSvg } from "../server/services/replicate";
import { getApp } from "./helpers";

describe("serving SVGs", () => {
	test("/images/*.svg is sandboxed and never sniffed; other images keep normal headers", async () => {
		const dir = path.join(process.cwd(), "generated-images");
		const existed = fs.existsSync(dir);
		fs.mkdirSync(dir, { recursive: true });
		const name = `test-${randomUUID()}`;
		fs.writeFileSync(path.join(dir, `${name}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"/>');
		fs.writeFileSync(path.join(dir, `${name}.txt`), "x");
		try {
			const app = await getApp();
			for (const url of [`/images/${name}.svg`, `/images/${name}.SVG?x=1`, `/images/${name}%2Esvg`]) {
				const res = await app.inject({ method: "GET", url });
				if (res.statusCode !== 200) continue; // case-sensitive filesystems 404 the .SVG variant
				expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
				expect(res.headers["x-content-type-options"]).toBe("nosniff");
			}
			const svg = await app.inject({ method: "GET", url: `/images/${name}.svg` });
			expect(svg.statusCode).toBe(200);
			const other = await app.inject({ method: "GET", url: `/images/${name}.txt` });
			expect(other.headers["content-security-policy"]).not.toBe(
				"sandbox; default-src 'none'; style-src 'unsafe-inline'",
			);
		} finally {
			fs.rmSync(path.join(dir, `${name}.svg`), { force: true });
			fs.rmSync(path.join(dir, `${name}.txt`), { force: true });
			if (!existed) fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64">${body}</svg>`;
const safe = (s: string | Buffer) => isSafeSvg(typeof s === "string" ? Buffer.from(s, "utf8") : s);

describe("SVG output safety", () => {
	test("plain vector drawings pass, including gradients and in-document references", () => {
		expect(safe(wrap('<rect width="10" height="10" fill="#c33"/><path d="M0 0L10 10" stroke="#000"/>'))).toBe(true);
		expect(
			safe(
				wrap(
					'<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><circle r="5" fill="url(#g)"/><!-- comment -->',
				),
			),
		).toBe(true);
	});

	test("script, event handlers and unknown elements are refused", () => {
		expect(safe(wrap("<script>alert(1)</script>"))).toBe(false);
		expect(safe(wrap('<rect onload="alert(1)"/>'))).toBe(false);
		expect(safe(wrap('<image href="https://evil.example/x.png"/>'))).toBe(false);
		expect(safe(wrap('<a href="#x"><rect/></a>'))).toBe(false);
		expect(safe(wrap("<style>@import url(https://evil.example/x.css)</style>"))).toBe(false);
	});

	test("entity-encoded or whitespace-split javascript: URLs are refused", () => {
		expect(safe(wrap('<pattern id="p" href="&#106;avascript:alert(1)"/>'))).toBe(false);
		expect(safe(wrap('<pattern id="p" href="&#x6A;&#x61;vascript&colon;alert(1)"/>'))).toBe(false);
		expect(safe(wrap('<pattern id="p" href="java&#9;script:alert(1)"/>'))).toBe(false);
		expect(safe(wrap('<rect fill="url(java script:alert(1))"/>'))).toBe(false);
		expect(safe(wrap('<rect o&#110;load="alert(1)"/>'))).toBe(false);
	});

	test("external references are refused even without a script scheme", () => {
		expect(safe(wrap('<pattern id="p" xlink:href="https://evil.example/p.svg#a"/>'))).toBe(false);
		expect(safe(wrap('<rect fill="url(https://evil.example/f.svg#g)"/>'))).toBe(false);
	});

	test("UTF-16, BOM-prefixed, NUL-laden and invalid UTF-8 files are refused", () => {
		const text = wrap('<rect width="1" height="1"/>');
		const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
		const utf16be = Buffer.from(Buffer.from(text, "utf16le").swap16());
		expect(safe(utf16le)).toBe(false);
		expect(safe(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]))).toBe(false);
		expect(safe(Buffer.from(text, "utf16le"))).toBe(false);
		expect(safe(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]))).toBe(false);
		expect(safe(Buffer.concat([Buffer.from(text), Buffer.from([0xc3, 0x28])]))).toBe(false);
	});

	test("DOCTYPE / entity declarations and stylesheets are refused", () => {
		expect(safe(`<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("")}`)).toBe(false);
		expect(safe(`<?xml-stylesheet href="https://evil.example/x.css"?>${wrap("")}`)).toBe(false);
	});
});
