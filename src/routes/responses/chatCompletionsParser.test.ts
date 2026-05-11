import { describe, it, expect } from "vitest";
import { parseChatCompletionsStream } from "./chatCompletionsParser.js";
import {
	createMockLogger,
	createTextChunk,
	createToolCallChunk,
	createUsageChunk,
	createReasoningChunk,
	collectEvents,
} from "./__test_helpers__/mocks.js";
import type { Logger } from "pino";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

function createMockStream(chunks: unknown[]): AsyncIterable<ChatCompletionChunk> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk as ChatCompletionChunk;
			}
		},
	};
}

describe("parseChatCompletionsStream", () => {
	const log = createMockLogger() as unknown as Logger;

	it("yields text_delta for text chunks", async () => {
		const stream = createMockStream([createTextChunk("Hello"), createTextChunk(" world")]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([
			{ type: "text_delta", content: "Hello" },
			{ type: "text_delta", content: " world" },
		]);
	});

	it("yields reasoning_delta for reasoning chunks", async () => {
		const stream = createMockStream([createReasoningChunk("thinking...")]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([{ type: "reasoning_delta", content: "thinking..." }]);
	});

	it("yields tool_call_start for tool call with name", async () => {
		const stream = createMockStream([createToolCallChunk("get_weather", undefined, "call_1")]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([{ type: "tool_call_start", toolCallId: "call_1", name: "get_weather" }]);
	});

	it("yields tool_call_args_delta for tool call arguments", async () => {
		const stream = createMockStream([createToolCallChunk(undefined, '{"city":"Paris"}')]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([{ type: "tool_call_args_delta", content: '{"city":"Paris"}' }]);
	});

	it("yields both tool_call_start and tool_call_args_delta when name and args are in same chunk", async () => {
		const stream = createMockStream([createToolCallChunk("get_weather", '{"city":"Paris"}', "call_1")]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([
			{ type: "tool_call_start", toolCallId: "call_1", name: "get_weather" },
			{ type: "tool_call_args_delta", content: '{"city":"Paris"}' },
		]);
	});

	it("yields usage event for usage chunks", async () => {
		const stream = createMockStream([createUsageChunk(10, 5)]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([{ type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 }]);
	});

	it("skips chunks with no choices", async () => {
		const emptyChunk = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [],
		};
		const stream = createMockStream([emptyChunk, createTextChunk("Hi")]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([{ type: "text_delta", content: "Hi" }]);
	});

	it("warns about multiple tool calls", async () => {
		const chunk = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, function: { name: "a" } },
							{ index: 1, function: { name: "b" } },
						],
					},
					finish_reason: null,
				},
			],
		};
		const stream = createMockStream([chunk]);
		await collectEvents(parseChatCompletionsStream(stream, log));

		expect(log.warn).toHaveBeenCalledWith("Multiple tool calls not supported, only the first will be processed");
	});

	it("yields usage and text from the same chunk", async () => {
		const chunk = {
			...createTextChunk("Hi"),
			usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
		};
		const stream = createMockStream([chunk]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([
			{ type: "usage", inputTokens: 5, outputTokens: 3, totalTokens: 8 },
			{ type: "text_delta", content: "Hi" },
		]);
	});

	it("defaults toolCallId to empty string when missing", async () => {
		const stream = createMockStream([createToolCallChunk("my_func", undefined, undefined)]);
		const events = await collectEvents(parseChatCompletionsStream(stream, log));

		expect(events).toEqual([{ type: "tool_call_start", toolCallId: "", name: "my_func" }]);
	});
});
