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

// Mock executeMcpTool
const mockExecuteMcpCall = vi.fn();
vi.mock("./executeMcpTool.js", () => ({
	executeMcpCall: (...args: unknown[]) => mockExecuteMcpCall(...args),
}));

import { innerRunStream } from "./innerStream.js";
import { callApprovedMCPToolStream } from "./mcpStream.js";
import { createMockReq, createMockResponseObject, collectEvents } from "./__test_helpers__/mocks.js";
import type { Context } from "@opentelemetry/api";

describe("innerRunStream", () => {
	const traceContext = {} as Context;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws when no authorization header", async () => {
		const req = createMockReq();
		req.headers = {}; // No authorization
		const responseObject = createMockResponseObject();

		await expect(collectEvents(innerRunStream(req, responseObject, traceContext))).rejects.toThrow(
			"Unauthorized: missing or invalid Authorization header"
		);
	});

	it("calls handleOneTurnStream with correct arguments", async () => {
		mockHandleOneTurnStream.mockReturnValue(
			(async function* () {
				// no events
			})()
		);

		const req = createMockReq({ input: "Hello", reasoning: { effort: "medium", summary: "detailed" } });
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

		expect(mockHandleOneTurnStream).toHaveBeenCalledTimes(1);
		const [apiKey, payload, , , , , , reasoningSummaryMode] = mockHandleOneTurnStream.mock.calls[0];
		expect(apiKey).toBe("test-api-key");
		expect(payload.model).toBe("test-model");
		expect(payload.stream).toBe(true);
		expect(reasoningSummaryMode).toBe("detailed");
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
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

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
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

		const payload = mockHandleOneTurnStream.mock.calls[0][1];
		expect(payload.tools).toBeUndefined();
	});

	it("runs LLM loop with max iterations", async () => {
		let callCount = 0;
		mockHandleOneTurnStream.mockImplementation((_apiKey, _payload, responseObject) => {
			callCount++;
			if (callCount <= 3) {
				// Simulate model returning an MCP tool call each iteration
				responseObject.output.push({
					type: "mcp_call",
					id: `mcp_iter_${callCount}`,
					name: "search",
					server_label: "test-server",
					arguments: "{}",
				});
			}
			return (async function* () {
				// no events
			})();
		});

		// Mock executeMcpCall to return messages (so the loop continues)
		mockExecuteMcpCall.mockImplementation((mcpCallItem: Record<string, unknown>) => {
			mcpCallItem.output = "result";
			return {
				events: [],
				messages: [
					{ role: "assistant", tool_calls: [{ id: mcpCallItem.id, type: "function", function: { name: "search", arguments: "{}" } }] },
					{ role: "tool", tool_call_id: mcpCallItem.id, content: "result" },
				],
			};
		});

		const req = createMockReq({ input: "Hello" });
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

		// Should have called handleOneTurnStream 4 times (3 with MCP + 1 final with no new messages)
		expect(mockHandleOneTurnStream).toHaveBeenCalledTimes(4);
		expect(mockExecuteMcpCall).toHaveBeenCalledTimes(3);
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
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

		const defaultHeaders = mockHandleOneTurnStream.mock.calls[0][4];
		expect(defaultHeaders["x-custom-header"]).toBe("custom-value");
		expect(defaultHeaders["content-type"]).toBeUndefined();
		expect(defaultHeaders["host"]).toBeUndefined();
		expect(defaultHeaders["authorization"]).toBeUndefined();
	});

	it("stops loop when output has both an unresolved function_call and mcp_approval_request", async () => {
		mockHandleOneTurnStream.mockImplementation((_apiKey, _payload, responseObject) => {
			// Simulate the model returning a function_call, mcp_approval_request, and mcp_call
			// The mcp_call is last so it triggers executeMcpCall, but hasUserTask stops the loop
			responseObject.output.push(
				{
					type: "function_call",
					id: "fc_test1",
					call_id: "call_abc",
					name: "get_weather",
					arguments: '{"city":"Paris"}',
					status: "completed",
				},
				{
					type: "mcp_approval_request",
					id: "mcpr_test1",
					name: "delete_file",
					server_label: "gitmcp",
					arguments: '{"path":"/tmp/x"}',
				},
				{
					type: "mcp_call",
					id: "mcp_test1",
					name: "search",
					server_label: "gitmcp",
					arguments: "{}",
				}
			);
			return (async function* () {
				// no stream events needed for this test
			})();
		});

		mockExecuteMcpCall.mockImplementation((mcpCallItem: Record<string, unknown>) => {
			mcpCallItem.output = "search result";
			return {
				events: [],
				messages: [
					{ role: "assistant", tool_calls: [{ id: mcpCallItem.id, type: "function", function: { name: "search", arguments: "{}" } }] },
					{ role: "tool", tool_call_id: mcpCallItem.id, content: "search result" },
				],
			};
		});

		const req = createMockReq({
			input: [{ role: "user", content: "Do stuff" }],
			tools: [{ type: "function" as const, name: "get_weather", parameters: { type: "object" } }],
		});
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

		// Even though messages were added (MCP auto-call), the loop should NOT iterate again
		// because there is an unresolved function_call and mcp_approval_request
		expect(mockHandleOneTurnStream).toHaveBeenCalledTimes(1);
		expect(mockExecuteMcpCall).toHaveBeenCalledTimes(1);
	});

	it("continues loop when function_call and mcp_approval_request are already resolved in input", async () => {
		let callCount = 0;
		mockHandleOneTurnStream.mockImplementation((_apiKey, _payload, responseObject) => {
			callCount++;
			if (callCount === 1) {
				// First turn: model returns a function_call, mcp_approval_request, and mcp_call
				// The function_call and mcp_approval_request are already resolved in input
				responseObject.output.push(
					{
						type: "function_call",
						id: "fc_test2",
						call_id: "call_already_resolved",
						name: "get_weather",
						arguments: '{"city":"Paris"}',
						status: "completed",
					},
					{
						type: "mcp_approval_request",
						id: "mcpr_already_resolved",
						name: "delete_file",
						server_label: "gitmcp",
						arguments: '{"path":"/tmp/x"}',
					},
					{
						type: "mcp_call",
						id: "mcp_test2",
						name: "search",
						server_label: "gitmcp",
						arguments: "{}",
					}
				);
			}
			// Second turn: no new output items, loop ends naturally
			return (async function* () {})();
		});

		mockExecuteMcpCall.mockImplementation((mcpCallItem: Record<string, unknown>) => {
			mcpCallItem.output = "result";
			return {
				events: [],
				messages: [
					{ role: "assistant", tool_calls: [{ id: mcpCallItem.id, type: "function", function: { name: "search", arguments: "{}" } }] },
					{ role: "tool", tool_call_id: mcpCallItem.id, content: "result" },
				],
			};
		});

		// Mock callApprovedMCPToolStream so the approval-processing section before the loop works
		vi.mocked(callApprovedMCPToolStream).mockReturnValue((async function* () {})());

		const req = createMockReq({
			input: [
				{ role: "user", content: "Do stuff" },
				// Matching function_call_output for the function_call
				{ type: "function_call_output" as const, call_id: "call_already_resolved", output: "sunny" },
				// The mcp_approval_request that the response references
				{
					type: "mcp_approval_request" as const,
					id: "mcpr_already_resolved",
					server_label: "gitmcp",
					name: "delete_file",
					arguments: '{"path":"/tmp/x"}',
				},
				// Matching mcp_approval_response for the mcp_approval_request
				{
					type: "mcp_approval_response" as const,
					approval_request_id: "mcpr_already_resolved",
					approve: true,
					reason: "ok",
				},
			],
			tools: [{ type: "function" as const, name: "get_weather", parameters: { type: "object" } }],
		});
		const responseObject = createMockResponseObject();

		await collectEvents(innerRunStream(req, responseObject, traceContext));

		// Both items are resolved in input, so hasUserTask stays false and the loop continues
		// to a second iteration (which adds no messages, ending the loop)
		expect(mockHandleOneTurnStream).toHaveBeenCalledTimes(2);
		expect(mockExecuteMcpCall).toHaveBeenCalledTimes(1);
	});
});
