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

import { buildResponsesEvents } from "./responsesEventBuilder.js";
import { createMockResponseObject, createMockLogger, collectEvents } from "./__test_helpers__/mocks.js";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { LLMOutputEvent } from "./llmEvents.js";

async function* fromArray(events: LLMOutputEvent[]): AsyncGenerator<LLMOutputEvent> {
	for (const event of events) {
		yield event;
	}
}

describe("buildResponsesEvents", () => {
	const traceContext = {} as Context;
	const log = createMockLogger() as unknown as Logger;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("produces text streaming event sequence from text_delta events", async () => {
		const llmEvents: LLMOutputEvent[] = [
			{ type: "text_delta", content: "Hello" },
			{ type: "text_delta", content: " world" },
		];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set())
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
		const llmEvents: LLMOutputEvent[] = [
			{ type: "text_delta", content: "Hello" },
			{ type: "text_delta", content: " world" },
		];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set())
		);

		const textDeltas = events
			.filter((e) => e.type === "response.output_text.delta")
			.map((e) => (e as unknown as Record<string, unknown>).delta);
		expect(textDeltas).toEqual(["Hello", " world"]);

		const doneEvent = events.find((e) => e.type === "response.output_text.done");
		expect((doneEvent as unknown as Record<string, unknown>).text).toBe("Hello world");
	});

	it("updates usage from usage events", async () => {
		const llmEvents: LLMOutputEvent[] = [
			{ type: "text_delta", content: "Hi" },
			{ type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		];

		const responseObject = createMockResponseObject();
		await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set())
		);

		expect(responseObject.usage?.input_tokens).toBe(10);
		expect(responseObject.usage?.output_tokens).toBe(5);
		expect(responseObject.usage?.total_tokens).toBe(15);
	});

	it("creates function_call output for non-MCP tool calls", async () => {
		const llmEvents: LLMOutputEvent[] = [
			{ type: "tool_call_start", toolCallId: "call_1", name: "get_weather" },
			{ type: "tool_call_args_delta", content: '{"city":"Paris"}' },
		];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set())
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.function_call_arguments.delta");
		expect(types).toContain("response.function_call_arguments.done");
		expect(types).toContain("response.output_item.done");
	});

	it("creates mcp_call output for MCP tools", async () => {
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

		const { callMcpTool } = await import("../../mcp.js");
		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "result" });

		const llmEvents: LLMOutputEvent[] = [
			{ type: "tool_call_start", toolCallId: "call_1", name: "mcp_tool" },
			{ type: "tool_call_args_delta", content: '{"a":1}' },
		];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, mcpToolsMapping, traceContext, log, new Set())
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.mcp_call.in_progress");
		expect(types).toContain("response.mcp_call_arguments.delta");
	});

	it("handles reasoning then text switching", async () => {
		const llmEvents: LLMOutputEvent[] = [
			{ type: "reasoning_delta", content: "thinking..." },
			{ type: "text_delta", content: "answer" },
		];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set())
		);

		const types = events.map((e) => e.type);
		expect(types).toContain("response.reasoning_text.delta");
		expect(types).toContain("response.output_text.delta");
	});

	it("mirrors raw reasoning into summary when detailed mode", async () => {
		const llmEvents: LLMOutputEvent[] = [
			{ type: "reasoning_delta", content: "thinking" },
			{ type: "reasoning_delta", content: "..." },
		];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set(), "detailed")
		);

		const reasoningItem = responseObject.output.find((item) => item.type === "reasoning");
		expect(reasoningItem?.content).toEqual([]);
		expect(reasoningItem?.summary).toEqual([{ type: "summary_text", text: "thinking..." }]);
		expect(events.map((e) => e.type)).toEqual([
			"response.output_item.added",
			"response.reasoning_summary_part.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.reasoning_summary_part.done",
			"response.output_item.done",
		]);
	});

	it("keeps reasoning summary empty by default", async () => {
		const llmEvents: LLMOutputEvent[] = [{ type: "reasoning_delta", content: "thinking..." }];

		const responseObject = createMockResponseObject();
		await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set())
		);

		const reasoningItem = responseObject.output.find((item) => item.type === "reasoning");
		expect(reasoningItem?.summary).toEqual([]);
	});

	it("does not mirror raw reasoning for auto summaries", async () => {
		const llmEvents: LLMOutputEvent[] = [{ type: "reasoning_delta", content: "thinking..." }];

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			buildResponsesEvents(fromArray(llmEvents), responseObject, new Map(), traceContext, log, new Set(), "auto")
		);

		const reasoningItem = responseObject.output.find((item) => item.type === "reasoning");
		expect(reasoningItem?.summary).toEqual([]);
		expect(events.map((e) => e.type)).not.toContain("response.reasoning_summary_text.delta");
	});
});
