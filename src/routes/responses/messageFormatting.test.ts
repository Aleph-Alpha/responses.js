import { describe, it, expect } from "vitest";
import { formatInputToMessages } from "./messageFormatting.js";

describe("formatInputToMessages", () => {
	it("converts a string input to a user message", () => {
		const result = formatInputToMessages("Hello world", null);
		expect(result).toEqual([{ role: "user", content: "Hello world" }]);
	});

	it("prepends system message when instructions are provided", () => {
		const result = formatInputToMessages("Hi", "You are helpful");
		expect(result).toEqual([
			{ role: "system", content: "You are helpful" },
			{ role: "user", content: "Hi" },
		]);
	});

	it("does not prepend system message when instructions are null", () => {
		const result = formatInputToMessages("Hi", null);
		expect(result).toEqual([{ role: "user", content: "Hi" }]);
	});

	it("maps message items with string content", () => {
		const result = formatInputToMessages(
			[
				{ type: "message" as const, role: "user" as const, content: "Hello" },
				{ type: "message" as const, role: "assistant" as const, content: "Hi there" },
			],
			null
		);
		expect(result).toEqual([
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		]);
	});

	it("maps input_text content to text type", () => {
		const result = formatInputToMessages(
			[
				{
					type: "message" as const,
					role: "user" as const,
					content: [{ type: "input_text" as const, text: "Hello" }],
				},
			],
			null
		);
		// Single text part is flattened to a string
		expect(result).toEqual([{ role: "user", content: "Hello" }]);
	});

	it("maps input_image to image_url type", () => {
		const result = formatInputToMessages(
			[
				{
					type: "message" as const,
					role: "user" as const,
					content: [
						{ type: "input_text" as const, text: "Look at this" },
						{ type: "input_image" as const, image_url: "https://example.com/img.png" },
					],
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this" },
					{ type: "image_url", image_url: { url: "https://example.com/img.png" } },
				],
			},
		]);
	});

	it("flattens single text content part to string", () => {
		const result = formatInputToMessages(
			[
				{
					type: "message" as const,
					role: "user" as const,
					content: [{ type: "input_text" as const, text: "Single" }],
				},
			],
			null
		);
		expect(result).toEqual([{ role: "user", content: "Single" }]);
	});

	it("filters out refusal content parts", () => {
		const result = formatInputToMessages(
			[
				{
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{ type: "output_text" as const, text: "Hello" },
						{ type: "refusal" as const, refusal: "I can't" },
					],
					status: "completed" as const,
				},
			],
			null
		);
		expect(result).toEqual([{ role: "assistant", content: "Hello" }]);
	});

	it("filters out output_text with empty text", () => {
		const result = formatInputToMessages(
			[
				{
					type: "message" as const,
					role: "assistant" as const,
					content: [{ type: "output_text" as const, text: "" }],
					status: "completed" as const,
				},
			],
			null
		);
		// empty content array → filtered out
		expect(result).toEqual([]);
	});

	it("maps function_call to tool message", () => {
		const result = formatInputToMessages(
			[
				{
					type: "function_call" as const,
					call_id: "call_123",
					name: "get_weather",
					arguments: '{"city":"Paris"}',
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "tool",
				content: '{"city":"Paris"}',
				tool_call_id: "call_123",
			},
		]);
	});

	it("maps function_call_output to tool message", () => {
		const result = formatInputToMessages(
			[
				{
					type: "function_call_output" as const,
					call_id: "call_123",
					output: "Sunny, 25C",
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "tool",
				content: "Sunny, 25C",
				tool_call_id: "call_123",
			},
		]);
	});

	it("maps mcp_call to tool message", () => {
		const result = formatInputToMessages(
			[
				{
					type: "mcp_call" as const,
					id: "mcp_123",
					name: "tool1",
					server_label: "server1",
					arguments: '{"a":1}',
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "tool",
				content: "MCP call (mcp_123). Server: 'server1'. Tool: 'tool1'. Arguments: '{\"a\":1}'.",
				tool_call_id: "mcp_call",
			},
		]);
	});

	it("maps mcp_approval_request to tool message", () => {
		const result = formatInputToMessages(
			[
				{
					type: "mcp_approval_request" as const,
					id: "mcpr_123",
					name: "tool1",
					server_label: "server1",
					arguments: "{}",
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "tool",
				content: "MCP approval request (mcpr_123). Server: 'server1'. Tool: 'tool1'. Arguments: '{}'.",
				tool_call_id: "mcp_approval_request",
			},
		]);
	});

	it("maps mcp_approval_response to tool message", () => {
		const result = formatInputToMessages(
			[
				{
					type: "mcp_approval_response" as const,
					id: "resp_123",
					approval_request_id: "mcpr_123",
					approve: true,
					reason: null,
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "tool",
				content: "MCP approval response (resp_123). Approved: true. Reason: null.",
				tool_call_id: "mcp_approval_response",
			},
		]);
	});

	it("maps mcp_list_tools to tool message with interpolated server_label", () => {
		const result = formatInputToMessages(
			[
				{
					type: "mcp_list_tools" as const,
					id: "mcp_lt_123",
					server_label: "my-server",
					tools: [],
				},
			],
			null
		);
		expect(result).toEqual([
			{
				role: "tool",
				content: "MCP list tools. Server: 'my-server'.",
				tool_call_id: "mcp_list_tools",
			},
		]);
	});

	it("filters undefined messages from developer role", () => {
		const result = formatInputToMessages(
			[
				{
					type: "message" as const,
					role: "developer" as const,
					content: [{ type: "input_text" as const, text: "dev instructions" }],
					status: null,
				},
			],
			null
		);
		// developer role is not in the accepted list (assistant, user, system), returns undefined and is filtered
		expect(result).toEqual([]);
	});
});
