import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock OpenAI — must be a class so `new OpenAI(...)` works
const mockCreate = vi.fn();
vi.mock("openai", () => {
	class APIError extends Error {
		status: number;
		constructor(message: string, status: number) {
			super(message);
			this.status = status;
		}
	}
	const OpenAI = class {
		chat = { completions: { create: mockCreate } };
		static APIError = APIError;
	};
	return { OpenAI };
});

// Mock opentelemetry
vi.mock("@opentelemetry/api", () => {
	const mockSpan = {
		setAttribute: vi.fn(),
		setAttributes: vi.fn(),
		recordException: vi.fn(),
		setStatus: vi.fn(),
		end: vi.fn(),
	};
	const mockCounter = { add: vi.fn() };
	const mockHistogram = { record: vi.fn() };
	return {
		trace: {
			getTracer: vi.fn().mockReturnValue({
				startSpan: vi.fn().mockReturnValue(mockSpan),
			}),
		},
		metrics: {
			getMeter: vi.fn().mockReturnValue({
				createCounter: vi.fn().mockReturnValue(mockCounter),
				createHistogram: vi.fn().mockReturnValue(mockHistogram),
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

import { handleOneTurnStream } from "./handleOneTurn.js";
import {
	createMockResponseObject,
	createMockLogger,
	createTextChunk,
	createToolCallChunk,
	createUsageChunk,
	createReasoningChunk,
	collectEvents,
} from "./__test_helpers__/mocks.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { trace, SpanStatusCode, type Context } from "@opentelemetry/api";
import type { Logger } from "pino";

function createMockStream(chunks: unknown[]): { [Symbol.asyncIterator]: () => AsyncIterator<unknown> } {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

describe("handleOneTurnStream", () => {
	const traceContext = {} as Context;
	const log = createMockLogger() as unknown as Logger;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	const basePayload: ChatCompletionCreateParamsStreaming = {
		model: "test-model",
		messages: [{ role: "user", content: "Hello" }],
		stream: true,
	};

	it("produces text streaming event sequence", async () => {
		const chunks = [createTextChunk("Hello"), createTextChunk(" world")];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log)
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.content_part.added");
		expect(types).toContain("response.output_text.delta");
		expect(types).toContain("response.output_text.done");
		expect(types).toContain("response.content_part.done");
		expect(types).toContain("response.output_item.done");
	});

	it("accumulates text deltas", async () => {
		const chunks = [createTextChunk("Hello"), createTextChunk(" world")];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log)
		);

		const textDeltas = events
			.filter((e) => e.type === "response.output_text.delta")
			.map((e) => (e as Record<string, unknown>).delta);
		expect(textDeltas).toEqual(["Hello", " world"]);

		// Final text in done event
		const doneEvent = events.find((e) => e.type === "response.output_text.done");
		expect((doneEvent as Record<string, unknown>).text).toBe("Hello world");
	});

	it("handles usage chunks", async () => {
		const chunks = [createTextChunk("Hi"), createUsageChunk(10, 5)];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log)
		);

		expect(responseObject.usage?.input_tokens).toBe(10);
		expect(responseObject.usage?.output_tokens).toBe(5);
		expect(responseObject.usage?.total_tokens).toBe(15);
	});

	it("handles tool call streaming", async () => {
		const chunks = [
			createToolCallChunk("get_weather", undefined, "call_1"),
			createToolCallChunk(undefined, '{"city":'),
			createToolCallChunk(undefined, '"Paris"}'),
		];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log)
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.function_call_arguments.delta");
		expect(types).toContain("response.function_call_arguments.done");
		expect(types).toContain("response.output_item.done");
	});

	it("routes MCP tool calls based on mcpToolsMapping", async () => {
		const chunks = [createToolCallChunk("mcp_tool", undefined, "call_1"), createToolCallChunk(undefined, '{"a":1}')];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const mcpToolsMapping = new Map([
			[
				"mcp_tool",
				{
					server_label: "test-server",
					server_url: "http://localhost:3001",
					type: "mcp" as const,
					allowed_tools: null,
					headers: null,
					require_approval: "never" as const,
				},
			],
		]);

		// Mock callMcpTool for the closeLastOutputItem call
		const { callMcpTool } = await import("../../mcp.js");
		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "result" });

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, mcpToolsMapping, {}, traceContext, log)
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.mcp_call.in_progress");
		expect(types).toContain("response.mcp_call_arguments.delta");
	});

	it("skips MCP events for already-called mcp_call items from previous turns", async () => {
		const chunks = [createToolCallChunk("mcp_tool", undefined, "call_1"), createToolCallChunk(undefined, '{"a":1}')];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const mcpToolsMapping = new Map([
			[
				"mcp_tool",
				{
					server_label: "test-server",
					server_url: "http://localhost:3001",
					type: "mcp" as const,
					allowed_tools: null,
					headers: null,
					require_approval: "never" as const,
				},
			],
		]);

		// Pre-populate responseObject.output with an mcp_call that has the same ID
		// as the one that will be generated (generateUniqueId is mocked to return "mcp_test123")
		const responseObject = createMockResponseObject({
			output: [
				{
					type: "mcp_call",
					id: "mcp_test123",
					name: "mcp_tool",
					server_label: "test-server",
					arguments: '{"a":1}',
					output: "previous result",
				} as ResponseOutputItem.McpCall,
			],
		});

		const { callMcpTool } = await import("../../mcp.js");
		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "result" });

		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, mcpToolsMapping, {}, traceContext, log)
		);

		const types = events.map((e) => e.type);
		// Should NOT emit in_progress or argument deltas for already-called MCP
		expect(types).not.toContain("response.mcp_call.in_progress");
		expect(types).not.toContain("response.mcp_call_arguments.delta");
		// callMcpTool should NOT have been invoked since closeLastOutputItem skips it
		expect(callMcpTool).not.toHaveBeenCalled();
	});

	it("handles reasoning then text switching", async () => {
		const chunks = [createReasoningChunk("thinking..."), createTextChunk("answer")];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log)
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.reasoning_text.delta");
		expect(types).toContain("response.output_text.delta");
	});

	it("mirrors raw reasoning into summary when requested", async () => {
		const chunks = [createReasoningChunk("thinking"), createReasoningChunk("...")];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log, "auto")
		);

		const reasoningItem = responseObject.output.find((item) => item.type === "reasoning");
		expect(reasoningItem?.summary).toEqual([{ type: "summary_text", text: "thinking..." }]);
	});

	it("keeps reasoning summary empty by default", async () => {
		const chunks = [createReasoningChunk("thinking...")];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log)
		);

		const reasoningItem = responseObject.output.find((item) => item.type === "reasoning");
		expect(reasoningItem?.summary).toEqual([]);
	});

	it("propagates errors from the LLM stream", async () => {
		mockCreate.mockRejectedValue(new Error("API error"));

		const responseObject = createMockResponseObject();
		await expect(
			collectEvents(handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log))
		).rejects.toThrow("API error");
	});

	it("ends span and records error when client.chat.completions.create() rejects", async () => {
		const createError = new Error("auth failure");
		mockCreate.mockRejectedValue(createError);

		// Get a reference to the mock span via the mocked tracer
		const mockSpan = trace.getTracer("").startSpan("");

		const responseObject = createMockResponseObject();
		await expect(
			collectEvents(handleOneTurnStream("key", { ...basePayload }, responseObject, new Map(), {}, traceContext, log))
		).rejects.toThrow("auth failure");

		expect(mockSpan.recordException).toHaveBeenCalledWith(createError);
		expect(mockSpan.setStatus).toHaveBeenCalledWith({
			code: SpanStatusCode.ERROR,
			message: "auth failure",
		});
		expect(mockSpan.end).toHaveBeenCalled();
	});
});
