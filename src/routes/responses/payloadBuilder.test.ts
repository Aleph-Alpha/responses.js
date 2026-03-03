import { describe, it, expect } from "vitest";
import { buildLLMPayload } from "./payloadBuilder.js";
import type { CreateResponseParams } from "../../schemas.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

describe("buildLLMPayload", () => {
	const baseBody: CreateResponseParams = {
		model: "gpt-4",
		input: "Hi",
		instructions: null,
		max_output_tokens: null,
		metadata: null,
		stream: false,
		temperature: 0.7,
		top_p: 0.9,
	};

	const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "Hello" }];

	it("sets model and messages", () => {
		const payload = buildLLMPayload(baseBody, messages, undefined);
		expect(payload.model).toBe("gpt-4");
		expect(payload.messages).toEqual(messages);
		expect(payload.stream).toBe(true);
	});

	it("converts null max_output_tokens to undefined", () => {
		const payload = buildLLMPayload({ ...baseBody, max_output_tokens: null }, messages, undefined);
		expect(payload.max_tokens).toBeUndefined();
	});

	it("passes through numeric max_output_tokens", () => {
		const payload = buildLLMPayload({ ...baseBody, max_output_tokens: 1024 }, messages, undefined);
		expect(payload.max_tokens).toBe(1024);
	});

	it("handles json_schema response format", () => {
		const body: CreateResponseParams = {
			...baseBody,
			text: {
				format: {
					type: "json_schema" as const,
					name: "test_schema",
					schema: { type: "object" },
					strict: false,
					description: "A test schema",
				},
			},
		};
		const payload = buildLLMPayload(body, messages, undefined);
		expect(payload.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "test_schema",
				schema: { type: "object" },
				strict: false,
				description: "A test schema",
			},
		});
	});

	it("handles text response format", () => {
		const body: CreateResponseParams = {
			...baseBody,
			text: { format: { type: "text" as const } },
		};
		const payload = buildLLMPayload(body, messages, undefined);
		expect(payload.response_format).toEqual({ type: "text" });
	});

	it("handles json_object response format", () => {
		const body: CreateResponseParams = {
			...baseBody,
			text: { format: { type: "json_object" as const } },
		};
		const payload = buildLLMPayload(body, messages, undefined);
		expect(payload.response_format).toEqual({ type: "json_object" });
	});

	it("passes undefined response_format when text is not set", () => {
		const payload = buildLLMPayload(baseBody, messages, undefined);
		expect(payload.response_format).toBeUndefined();
	});

	it("maps string tool_choice directly", () => {
		const body: CreateResponseParams = { ...baseBody, tool_choice: "required" };
		const payload = buildLLMPayload(body, messages, undefined);
		expect(payload.tool_choice).toBe("required");
	});

	it("maps object tool_choice to function format", () => {
		const body: CreateResponseParams = {
			...baseBody,
			tool_choice: { type: "function" as const, name: "get_weather" },
		};
		const payload = buildLLMPayload(body, messages, undefined);
		expect(payload.tool_choice).toEqual({
			type: "function",
			function: { name: "get_weather" },
		});
	});

	it("passes tools through", () => {
		const tools = [
			{
				type: "function" as const,
				function: { name: "test", parameters: {} },
			},
		];
		const payload = buildLLMPayload(baseBody, messages, tools);
		expect(payload.tools).toEqual(tools);
	});

	it("passes undefined tools when empty", () => {
		const payload = buildLLMPayload(baseBody, messages, undefined);
		expect(payload.tools).toBeUndefined();
	});

	it("passes reasoning_effort from body", () => {
		const body: CreateResponseParams = {
			...baseBody,
			reasoning: { effort: "high" as const, summary: null },
		};
		const payload = buildLLMPayload(body, messages, undefined);
		expect(payload.reasoning_effort).toBe("high");
	});

	it("sets temperature and top_p", () => {
		const payload = buildLLMPayload(baseBody, messages, undefined);
		expect(payload.temperature).toBe(0.7);
		expect(payload.top_p).toBe(0.9);
	});
});
