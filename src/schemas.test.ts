import { describe, it, expect } from "vitest";
import { createResponseParamsSchema } from "./schemas.js";

describe("createResponseParamsSchema", () => {
	const minimalValid = {
		model: "test-model",
		input: "Hello",
	};

	it("parses a minimal valid request", () => {
		const result = createResponseParamsSchema.parse(minimalValid);
		expect(result.model).toBe("test-model");
		expect(result.input).toBe("Hello");
	});

	it("applies default values", () => {
		const result = createResponseParamsSchema.parse(minimalValid);
		expect(result.stream).toBe(false);
		expect(result.temperature).toBe(1);
		expect(result.top_p).toBe(1);
		expect(result.instructions).toBeNull();
		expect(result.max_output_tokens).toBeNull();
		expect(result.metadata).toBeNull();
	});

	it("accepts string input", () => {
		const result = createResponseParamsSchema.parse({ ...minimalValid, input: "test string" });
		expect(result.input).toBe("test string");
	});

	it("accepts array input with messages", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [{ role: "user", content: "Hello", type: "message" }],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts message with input_text content", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "Hello" }],
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts message with input_image content", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					role: "user",
					content: [{ type: "input_image", image_url: "https://example.com/img.png" }],
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts function_call input", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "get_weather",
					arguments: '{"city":"Paris"}',
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts function_call_output input", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "Sunny, 25C",
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts mcp_list_tools input", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					type: "mcp_list_tools",
					id: "mcpl_1",
					server_label: "test",
					tools: [{ name: "search", input_schema: { type: "object" } }],
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts mcp_approval_request input", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					type: "mcp_approval_request",
					id: "mcpr_1",
					server_label: "test",
					name: "search",
					arguments: "{}",
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts mcp_approval_response input", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			input: [
				{
					type: "mcp_approval_response",
					approval_request_id: "mcpr_1",
					approve: true,
				},
			],
		});
		expect(Array.isArray(result.input)).toBe(true);
	});

	it("accepts function tools", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			tools: [
				{
					type: "function",
					name: "get_weather",
					parameters: { type: "object" },
				},
			],
		});
		expect(result.tools).toHaveLength(1);
	});

	it("accepts mcp tools", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			tools: [
				{
					type: "mcp",
					server_label: "test",
					server_url: "http://localhost:3001",
				},
			],
		});
		expect(result.tools).toHaveLength(1);
	});

	it("accepts string tool_choice", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			tool_choice: "required",
		});
		expect(result.tool_choice).toBe("required");
	});

	it("accepts object tool_choice", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			tool_choice: { type: "function", name: "get_weather" },
		});
		expect(result.tool_choice).toEqual({ type: "function", name: "get_weather" });
	});

	it("accepts text format options", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			text: { format: { type: "json_object" } },
		});
		expect(result.text?.format.type).toBe("json_object");
	});

	it("accepts json_schema format", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			text: {
				format: {
					type: "json_schema",
					name: "test",
					schema: { type: "object" },
				},
			},
		});
		expect(result.text?.format.type).toBe("json_schema");
	});

	it("accepts reasoning options", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			reasoning: { effort: "high", summary: "raw" },
		});
		expect(result.reasoning?.effort).toBe("high");
		expect(result.reasoning?.summary).toBe("raw");
	});

	it("accepts opting out of reasoning summaries", () => {
		const result = createResponseParamsSchema.parse({
			...minimalValid,
			reasoning: { summary: "none" },
		});
		expect(result.reasoning?.summary).toBe("none");
	});

	it("rejects invalid temperature", () => {
		expect(() =>
			createResponseParamsSchema.parse({
				...minimalValid,
				temperature: 3,
			})
		).toThrow();
	});

	it("rejects invalid top_p", () => {
		expect(() =>
			createResponseParamsSchema.parse({
				...minimalValid,
				top_p: 2,
			})
		).toThrow();
	});

	it("rejects negative max_output_tokens", () => {
		expect(() =>
			createResponseParamsSchema.parse({
				...minimalValid,
				max_output_tokens: -1,
			})
		).toThrow();
	});

	it("rejects metadata with too many keys", () => {
		const metadata: Record<string, string> = {};
		for (let i = 0; i < 17; i++) {
			metadata[`key${i}`] = "value";
		}
		expect(() =>
			createResponseParamsSchema.parse({
				...minimalValid,
				metadata,
			})
		).toThrow();
	});

	it("rejects missing model", () => {
		expect(() => createResponseParamsSchema.parse({ input: "test" })).toThrow();
	});

	it("rejects missing input", () => {
		expect(() => createResponseParamsSchema.parse({ model: "test" })).toThrow();
	});
});
