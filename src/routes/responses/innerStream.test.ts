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

// Mock mcp.js
vi.mock("../../mcp.js", () => ({
	callMcpTool: vi.fn(),
	connectMcpServer: vi.fn(),
}));

// Mock handleOneTurnStream
const mockHandleOneTurnStream = vi.fn();
vi.mock("./handleOneTurn.js", () => ({
	handleOneTurnStream: (...args: unknown[]) => mockHandleOneTurnStream(...args),
}));

// Mock mcpStream
vi.mock("./mcpStream.js", () => ({
	listMcpToolsStream: vi.fn(),
	callApprovedMCPToolStream: vi.fn(),
}));

import { innerRunStream } from "./innerStream.js";
import { createMockReq, createMockRes, createMockResponseObject, collectEvents } from "./__test_helpers__/mocks.js";
import type { Context } from "@opentelemetry/api";

describe("innerRunStream", () => {
	const traceContext = {} as Context;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns 401 when no authorization header", async () => {
		const req = createMockReq();
		req.headers = {}; // No authorization
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		const events = await collectEvents(
			innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext)
		);

		expect(events).toHaveLength(0);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(res.json).toHaveBeenCalledWith({
			success: false,
			error: "Unauthorized",
		});
	});

	it("throws when unsupported reasoning summary is provided", async () => {
		const req = createMockReq({
			reasoning: { effort: "medium", summary: "detailed" },
		});
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		await expect(
			collectEvents(innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext))
		).rejects.toThrow("Not implemented: only 'auto' summary is supported");
	});

	it("calls handleOneTurnStream with correct arguments", async () => {
		mockHandleOneTurnStream.mockReturnValue(
			(async function* () {
				// no events
			})()
		);

		const req = createMockReq({ input: "Hello" });
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext));

		expect(mockHandleOneTurnStream).toHaveBeenCalledTimes(1);
		const [apiKey, payload] = mockHandleOneTurnStream.mock.calls[0];
		expect(apiKey).toBe("test-api-key");
		expect(payload.model).toBe("test-model");
		expect(payload.stream).toBe(true);
	});

	it("builds function tools correctly", async () => {
		mockHandleOneTurnStream.mockReturnValue(
			(async function* () {
				// no events
			})()
		);

		const req = createMockReq({
			tools: [
				{
					type: "function" as const,
					name: "get_weather",
					parameters: { type: "object" },
					strict: false,
				},
			],
		});
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext));

		const payload = mockHandleOneTurnStream.mock.calls[0][1];
		expect(payload.tools).toEqual([
			{
				type: "function",
				function: {
					name: "get_weather",
					parameters: { type: "object" },
					description: undefined,
					strict: false,
				},
			},
		]);
	});

	it("sets tools to undefined when no tools are provided", async () => {
		mockHandleOneTurnStream.mockReturnValue(
			(async function* () {
				// no events
			})()
		);

		const req = createMockReq({ tools: undefined });
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext));

		const payload = mockHandleOneTurnStream.mock.calls[0][1];
		expect(payload.tools).toBeUndefined();
	});

	it("runs LLM loop with max iterations", async () => {
		let callCount = 0;
		mockHandleOneTurnStream.mockImplementation((_apiKey, payload) => {
			callCount++;
			// Simulate adding messages each iteration (like MCP tool calls)
			if (callCount <= 3) {
				payload.messages.push({ role: "tool", content: "result", tool_call_id: `call_${callCount}` });
			}
			return (async function* () {
				// no events
			})();
		});

		const req = createMockReq({ input: "Hello" });
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext));

		// Should have called handleOneTurnStream 4 times (3 with added messages + 1 final with no new messages)
		expect(mockHandleOneTurnStream).toHaveBeenCalledTimes(4);
	});

	it("filters non-forwarded headers", async () => {
		mockHandleOneTurnStream.mockReturnValue(
			(async function* () {
				// no events
			})()
		);

		const req = createMockReq();
		req.headers = {
			authorization: "Bearer test-key",
			"x-custom-header": "custom-value",
			"content-type": "application/json",
			host: "localhost",
		};
		const res = createMockRes();
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, res as Parameters<typeof innerRunStream>[1], responseObject, traceContext));

		const defaultHeaders = mockHandleOneTurnStream.mock.calls[0][4];
		expect(defaultHeaders["x-custom-header"]).toBe("custom-value");
		expect(defaultHeaders["content-type"]).toBeUndefined();
		expect(defaultHeaders["host"]).toBeUndefined();
		expect(defaultHeaders["authorization"]).toBeUndefined();
	});
});
