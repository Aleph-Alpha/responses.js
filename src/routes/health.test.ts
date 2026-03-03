import { describe, it, expect, vi } from "vitest";
import { getHealth } from "./health.js";
import type { Request, Response } from "express";

describe("getHealth", () => {
	it("responds with OK", () => {
		const req = {} as Request;
		const res = { send: vi.fn() } as unknown as Response;

		getHealth(req, res);

		expect(res.send).toHaveBeenCalledWith("OK");
	});
});
