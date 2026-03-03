import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock OpenAI — must be a class so `new OpenAI(...)` works
const mockCreate = vi.fn();
vi.mock("openai", () => {
	return {
		OpenAI: class {
			chat = { completions: { create: mockCreate } };
		},
	};
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
import type { Context } from "@opentelemetry/api";

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
	const log = createMockLogger() as any;

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
			handleOneTurnStream("key", { ...basePayload }, responseObject, {}, {}, traceContext, log)
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
			handleOneTurnStream("key", { ...basePayload }, responseObject, {}, {}, traceContext, log)
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
		await collectEvents(handleOneTurnStream("key", { ...basePayload }, responseObject, {}, {}, traceContext, log));

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
			handleOneTurnStream("key", { ...basePayload }, responseObject, {}, {}, traceContext, log)
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

		const mcpToolsMapping = {
			mcp_tool: {
				server_label: "test-server",
				server_url: "http://localhost:3001",
				type: "mcp" as const,
				allowed_tools: null,
				headers: null,
				require_approval: "never" as const,
			},
		};

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

	it("handles reasoning then text switching", async () => {
		const chunks = [createReasoningChunk("thinking..."), createTextChunk("answer")];
		mockCreate.mockResolvedValue(createMockStream(chunks));

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			handleOneTurnStream("key", { ...basePayload }, responseObject, {}, {}, traceContext, log)
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.reasoning_text.delta");
		expect(types).toContain("response.output_text.delta");
	});

	it("propagates errors from the LLM stream", async () => {
		mockCreate.mockRejectedValue(new Error("API error"));

		const responseObject = createMockResponseObject();
		await expect(
			collectEvents(handleOneTurnStream("key", { ...basePayload }, responseObject, {}, {}, traceContext, log))
		).rejects.toThrow("API error");
	});
});
