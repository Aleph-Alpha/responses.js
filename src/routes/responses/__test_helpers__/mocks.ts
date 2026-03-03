import { vi } from "vitest";
import type { Response as ExpressResponse } from "express";
import type { ValidatedRequest } from "../../../middleware/validation.js";
import type { CreateResponseParams } from "../../../schemas.js";
import type { IncompleteResponse } from "../types.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

export function createMockSpan(): Record<string, ReturnType<typeof vi.fn>> {
	return {
		setAttribute: vi.fn(),
		setAttributes: vi.fn(),
		recordException: vi.fn(),
		setStatus: vi.fn(),
		end: vi.fn(),
		addEvent: vi.fn(),
		isRecording: vi.fn().mockReturnValue(true),
		updateName: vi.fn(),
	};
}

export function createMockTracer(
	span?: Record<string, ReturnType<typeof vi.fn>>
): Record<string, ReturnType<typeof vi.fn>> {
	const mockSpan = span ?? createMockSpan();
	return {
		startSpan: vi.fn().mockReturnValue(mockSpan),
	};
}

export function createMockRes(): Partial<ExpressResponse> & Record<string, ReturnType<typeof vi.fn>> {
	return {
		setHeader: vi.fn(),
		write: vi.fn().mockReturnValue(true),
		end: vi.fn(),
		json: vi.fn(),
		status: vi.fn().mockReturnThis(),
		once: vi.fn(),
		off: vi.fn(),
	};
}

export function createMockLogger(): Record<string, ReturnType<typeof vi.fn>> {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		trace: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

export function createMockReq(body: Partial<CreateResponseParams> = {}): ValidatedRequest<CreateResponseParams> {
	const defaultBody: CreateResponseParams = {
		model: "test-model",
		input: "Hello",
		instructions: null,
		max_output_tokens: null,
		metadata: null,
		stream: false,
		temperature: 1,
		top_p: 1,
		...body,
	};
	return {
		body: defaultBody,
		headers: {
			authorization: "Bearer test-api-key",
		},
		log: createMockLogger(),
	} as unknown as ValidatedRequest<CreateResponseParams>;
}

export function createMockResponseObject(overrides: Partial<IncompleteResponse> = {}): IncompleteResponse {
	return {
		created_at: 1234567890,
		error: null,
		id: "resp_test123",
		instructions: null,
		max_output_tokens: null,
		metadata: null,
		model: "test-model",
		object: "response",
		output: [],
		status: "in_progress",
		text: undefined,
		tool_choice: "auto",
		tools: [],
		temperature: 1,
		top_p: 1,
		usage: {
			input_tokens: 0,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 0,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 0,
		},
		...overrides,
	} as IncompleteResponse;
}

export function createTextChunk(content: string, index = 0): ChatCompletionChunk {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1234567890,
		model: "test-model",
		choices: [
			{
				index,
				delta: { content },
				finish_reason: null,
			},
		],
	} as ChatCompletionChunk;
}

export function createToolCallChunk(
	name: string | undefined,
	args: string | undefined,
	id?: string
): ChatCompletionChunk {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1234567890,
		model: "test-model",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: id,
							function: {
								name,
								arguments: args,
							},
						},
					],
				},
				finish_reason: null,
			},
		],
	} as ChatCompletionChunk;
}

export function createUsageChunk(prompt: number, completion: number): ChatCompletionChunk {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1234567890,
		model: "test-model",
		choices: [],
		usage: {
			prompt_tokens: prompt,
			completion_tokens: completion,
			total_tokens: prompt + completion,
		},
	} as ChatCompletionChunk;
}

export function createReasoningChunk(text: string): ChatCompletionChunk {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1234567890,
		model: "test-model",
		choices: [
			{
				index: 0,
				delta: { reasoning_content: text } as Record<string, unknown>,
				finish_reason: null,
			},
		],
	} as unknown as ChatCompletionChunk;
}

export async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}
