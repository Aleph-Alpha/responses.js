import { describe, it, expect, vi } from "vitest";
import { getLandingPageHtml } from "./landingPageHtml.js";
import type { Request, Response } from "express";

describe("getLandingPageHtml", () => {
	function createMockReq(host: string, protocol = "http"): Request {
		return {
			get: vi.fn((header: string) => (header === "host" ? host : undefined)),
			protocol,
		} as unknown as Request;
	}

	function createMockRes(): Response & { _body: string } {
		const res = {
			setHeader: vi.fn(),
			send: vi.fn().mockImplementation(function (body: string) {
				res._body = body;
			}),
			_body: "",
		};
		return res as unknown as Response & { _body: string };
	}

	it("sets Content-Type header to text/html", () => {
		const req = createMockReq("localhost:3000");
		const res = createMockRes();

		getLandingPageHtml(req, res);

		expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
	});

	it("includes the base URL in the response", () => {
		const req = createMockReq("localhost:3000");
		const res = createMockRes();

		getLandingPageHtml(req, res);

		expect(res._body).toContain("http://localhost:3000/v1");
	});

	it("forces HTTPS for .hf.space domains", () => {
		const req = createMockReq("my-space.hf.space", "http");
		const res = createMockRes();

		getLandingPageHtml(req, res);

		expect(res._body).toContain("https://my-space.hf.space/v1");
		expect(res._body).not.toContain("http://my-space.hf.space/v1");
	});

	it("uses request protocol for non-hf.space domains", () => {
		const req = createMockReq("example.com", "https");
		const res = createMockRes();

		getLandingPageHtml(req, res);

		expect(res._body).toContain("https://example.com/v1");
	});

	it("returns valid HTML", () => {
		const req = createMockReq("localhost:3000");
		const res = createMockRes();

		getLandingPageHtml(req, res);

		expect(res._body).toContain("<!DOCTYPE html>");
		expect(res._body).toContain("</html>");
	});

	it("includes the title", () => {
		const req = createMockReq("localhost:3000");
		const res = createMockRes();

		getLandingPageHtml(req, res);

		expect(res._body).toContain("responses.js");
	});
});
