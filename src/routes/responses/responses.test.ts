import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock opentelemetry
vi.mock("@opentelemetry/api", () => {
	const mockSpan = {
		setAttribute: vi.fn(),
		setAttributes: vi.fn(),
		recordException: vi.fn(),
		setStatus: vi.fn(),
		end: vi.fn(),
	};
	return {
		trace: {
			getTracer: vi.fn().mockReturnValue({
				startSpan: vi.fn().mockReturnValue(mockSpan),
			}),
			setSpan: vi.fn().mockReturnValue({}),
		},
		context: { active: vi.fn() },
		propagation: { extract: vi.fn() },
		SpanStatusCode: { ERROR: 2 },
	};
});

// Mock generateUniqueId
vi.mock("../../lib/generateUniqueId.js", () => ({
	generateUniqueId: vi.fn().mockImplementation((prefix) => `${prefix}_test123`),
}));

// Mock innerRunStream
const mockInnerRunStream = vi.fn();
vi.mock("./innerStream.js", () => ({
	innerRunStream: (...args: unknown[]) => mockInnerRunStream(...args),
}));

import { postCreateResponse } from "../responses.js";
import { createMockReq, createMockRes } from "./__test_helpers__/mocks.js";

describe("postCreateResponse", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sets SSE headers for streaming requests", async () => {
		mockInnerRunStream.mockReturnValue(
			(async function* () {
				// no events
			})()
		);

		const req = createMockReq({ stream: true });
		const res = createMockRes();

		await postCreateResponse(req, res as Parameters<typeof postCreateResponse>[1]);

		expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
		expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
		expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
		expect(res.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
		expect(res.end).toHaveBeenCalled();
	});

	it("writes SSE formatted events for streaming", async () => {
		mockInnerRunStream.mockReturnValue(
			(async function* () {
				// no inner events — the handler wraps with response.created etc.
			})()
		);

		const req = createMockReq({ stream: true });
		const res = createMockRes();

		await postCreateResponse(req, res as Parameters<typeof postCreateResponse>[1]);

		// Should have written response.created, response.in_progress, response.completed
		expect(res.write).toHaveBeenCalled();
		const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]);
		for (const call of writeCalls) {
			expect(call).toMatch(/^data: \{.*\}\n\n$/);
		}
	});

	it("assigns sequential sequence numbers to events", async () => {
		mockInnerRunStream.mockReturnValue(
			(async function* () {
				// no inner events
			})()
		);

		const req = createMockReq({ stream: true });
		const res = createMockRes();

		await postCreateResponse(req, res as Parameters<typeof postCreateResponse>[1]);

		const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) =>
			JSON.parse(c[0].replace("data: ", "").trim())
		);
		const seqNumbers = writeCalls.map((e: Record<string, number>) => e.sequence_number);
		for (let i = 0; i < seqNumbers.length; i++) {
			expect(seqNumbers[i]).toBe(i);
		}
	});

	it("returns JSON for non-streaming requests on response.completed", async () => {
		mockInnerRunStream.mockReturnValue(
			(async function* () {
				// no inner events
			})()
		);

		const req = createMockReq({ stream: false });
		const res = createMockRes();

		await postCreateResponse(req, res as Parameters<typeof postCreateResponse>[1]);

		expect(res.json).toHaveBeenCalled();
		const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(jsonCall).toHaveProperty("status", "completed");
		expect(jsonCall).toHaveProperty("object", "response");
	});

	it("yields response.failed on innerRunStream error", async () => {
		mockInnerRunStream.mockReturnValue(
			(async function* () {
				throw new Error("LLM error");
			})()
		);

		const req = createMockReq({ stream: false });
		const res = createMockRes();

		await postCreateResponse(req, res as Parameters<typeof postCreateResponse>[1]);

		expect(res.json).toHaveBeenCalled();
		const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(jsonCall).toHaveProperty("status", "failed");
		expect(jsonCall.error).toEqual({
			code: "server_error",
			message: "LLM error",
		});
	});

	it("yields response.failed with generic message for non-Error thrown", async () => {
		mockInnerRunStream.mockReturnValue(
			(async function* () {
				throw "string error";
			})()
		);

		const req = createMockReq({ stream: false });
		const res = createMockRes();

		await postCreateResponse(req, res as Parameters<typeof postCreateResponse>[1]);

		const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(jsonCall.error.message).toBe("An error occurred in stream");
	});
});
