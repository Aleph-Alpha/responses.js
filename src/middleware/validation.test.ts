import { describe, it, expect, vi } from "vitest";
import { validateBody } from "./validation.js";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

function createMockReq(body: unknown): Request {
	return { body } as Request;
}

function createMockRes(): Response {
	const res = {
		status: vi.fn().mockReturnThis(),
		json: vi.fn().mockReturnThis(),
	};
	return res as unknown as Response;
}

describe("validateBody", () => {
	const schema = z.object({
		name: z.string(),
		age: z.number().min(0),
	});

	it("calls next() when body is valid", () => {
		const req = createMockReq({ name: "Alice", age: 30 });
		const res = createMockRes();
		const next = vi.fn();

		validateBody(schema)(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(req.body).toEqual({ name: "Alice", age: 30 });
	});

	it("applies schema defaults/transforms to req.body", () => {
		const schemaWithDefault = z.object({
			name: z.string(),
			role: z.string().default("user"),
		});

		const req = createMockReq({ name: "Bob" });
		const res = createMockRes();
		const next = vi.fn();

		validateBody(schemaWithDefault)(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(req.body).toEqual({ name: "Bob", role: "user" });
	});

	it("returns 400 with ZodError details on validation failure", () => {
		const req = createMockReq({ name: 123 }); // name should be string
		const res = createMockRes();
		const next = vi.fn();

		validateBody(schema)(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				error: expect.any(Array),
				details: expect.any(Array),
			})
		);
	});

	it("returns 400 when required fields are missing", () => {
		const req = createMockReq({});
		const res = createMockRes();
		const next = vi.fn();

		validateBody(schema)(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("returns 500 for non-Zod errors", () => {
		// Create a schema that throws a non-Zod error
		const throwingSchema = {
			parse: () => {
				throw new Error("something broke");
			},
		} as unknown as z.ZodTypeAny;

		const req = createMockReq({ anything: true });
		const res = createMockRes();
		const next = vi.fn();

		validateBody(throwingSchema)(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({
			success: false,
			error: "Internal server error",
		});
	});
});
