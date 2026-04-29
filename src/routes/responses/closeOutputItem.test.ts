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

// Mock mcp.js
vi.mock("../../mcp.js", () => ({
	callMcpTool: vi.fn(),
	connectMcpServer: vi.fn(),
}));

import { closeLastOutputItem } from "./closeOutputItem.js";
import { callMcpTool } from "../../mcp.js";
import { createMockResponseObject, createMockLogger, collectEvents } from "./__test_helpers__/mocks.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type {
	ResponseOutputMessage,
	ResponseFunctionToolCall,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import type { PatchedResponseReasoningItem } from "../../openai_patch.js";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";

describe("closeLastOutputItem", () => {
	const traceContext = {} as Context;
	const log = createMockLogger() as unknown as Logger;
	const basePayload: ChatCompletionCreateParamsStreaming = {
		model: "test-model",
		messages: [{ role: "user", content: "Hello" }],
		stream: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does nothing when output is empty", async () => {
		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, new Map(), traceContext, log)
		);
		expect(events).toHaveLength(0);
	});

	it("closes a message output item", async () => {
		const responseObject = createMockResponseObject();
		const msg: ResponseOutputMessage = {
			id: "msg_1",
			type: "message",
			role: "assistant",
			status: "in_progress",
			content: [{ type: "output_text", text: "Hello world", annotations: [] }],
		};
		responseObject.output.push(msg);

		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, new Map(), traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.output_text.done", "response.content_part.done", "response.output_item.done"]);
		expect(msg.status).toBe("completed");
	});

	it("closes a reasoning output item", async () => {
		const responseObject = createMockResponseObject();
		const reasoning: PatchedResponseReasoningItem = {
			id: "rs_1",
			type: "reasoning",
			status: "in_progress",
			content: [{ type: "reasoning_text", text: "thinking..." }],
			summary: [],
		};
		responseObject.output.push(reasoning as unknown as ResponseOutputItem);

		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, new Map(), traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.reasoning_text.done", "response.content_part.done", "response.output_item.done"]);
		expect(reasoning.status).toBe("completed");
	});

	it("closes reasoning summary events when present", async () => {
		const responseObject = createMockResponseObject();
		const reasoning: PatchedResponseReasoningItem = {
			id: "rs_1",
			type: "reasoning",
			status: "in_progress",
			content: [{ type: "reasoning_text", text: "thinking..." }],
			summary: [{ type: "summary_text", text: "thinking..." }],
		};
		responseObject.output.push(reasoning as unknown as ResponseOutputItem);

		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, new Map(), traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toEqual([
			"response.reasoning_text.done",
			"response.content_part.done",
			"response.reasoning_summary_text.done",
			"response.reasoning_summary_part.done",
			"response.output_item.done",
		]);
		expect(events.find((e) => e.type === "response.reasoning_summary_text.done")).toMatchObject({
			summary_index: 0,
			text: "thinking...",
		});
		expect(reasoning.status).toBe("completed");
	});

	it("closes a function_call output item", async () => {
		const responseObject = createMockResponseObject();
		const fc: ResponseFunctionToolCall = {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "get_weather",
			arguments: '{"city":"Paris"}',
			status: "in_progress",
		};
		responseObject.output.push(fc);

		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, new Map(), traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.function_call_arguments.done", "response.output_item.done"]);
		expect(fc.status).toBe("completed");
	});

	it("closes an mcp_call output item and calls the MCP tool", async () => {
		const responseObject = createMockResponseObject();
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: '{"q":"test"}',
		};
		responseObject.output.push(mcpCall);

		const searchParams = {
			server_label: "test-server",
			server_url: "http://localhost:3001",
			type: "mcp" as const,
			allowed_tools: null,
			headers: null,
			require_approval: "never" as const,
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "search results" });

		const payload = { ...basePayload, messages: [...basePayload.messages] };
		const events = await collectEvents(
			closeLastOutputItem(responseObject, payload, mcpToolsMapping, traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toContain("response.mcp_call_arguments.done");
		expect(types).toContain("response.mcp_call.completed");
		expect(types).toContain("response.output_item.done");
		expect(callMcpTool).toHaveBeenCalledWith(searchParams, "search", '{"q":"test"}', log);
		// Verify payload was updated
		expect(payload.messages.length).toBeGreaterThan(1);
	});

	it("handles mcp_call tool error", async () => {
		const responseObject = createMockResponseObject();
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: "{}",
		};
		responseObject.output.push(mcpCall);

		const mcpToolsMapping = new Map([
			[
				"search",
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

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "tool failed" });

		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, mcpToolsMapping, traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toContain("response.mcp_call.failed");
		expect(types).toContain("response.output_item.done");
	});

	it("skips mcp_call entirely when ID is in alreadyCalledMcpIds", async () => {
		const responseObject = createMockResponseObject();
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: '{"q":"test"}',
		};
		responseObject.output.push(mcpCall);

		const searchParams = {
			server_label: "test-server",
			server_url: "http://localhost:3001",
			type: "mcp" as const,
			allowed_tools: null,
			headers: null,
			require_approval: "never" as const,
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);
		const alreadyCalledMcpIds = new Set(["mcp_1"]);

		const payload = { ...basePayload, messages: [...basePayload.messages] };
		const events = await collectEvents(
			closeLastOutputItem(responseObject, payload, mcpToolsMapping, traceContext, log, alreadyCalledMcpIds)
		);

		// Should yield no events at all for an already-called MCP item
		expect(events).toHaveLength(0);
		// callMcpTool should not have been called
		expect(callMcpTool).not.toHaveBeenCalled();
		// Payload should not have been modified
		expect(payload.messages).toHaveLength(basePayload.messages.length);
	});

	it("executes mcp_call when ID is NOT in alreadyCalledMcpIds", async () => {
		const responseObject = createMockResponseObject();
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_2",
			name: "search",
			server_label: "test-server",
			arguments: '{"q":"test"}',
		};
		responseObject.output.push(mcpCall);

		const searchParams = {
			server_label: "test-server",
			server_url: "http://localhost:3001",
			type: "mcp" as const,
			allowed_tools: null,
			headers: null,
			require_approval: "never" as const,
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);
		const alreadyCalledMcpIds = new Set(["mcp_1"]); // different ID

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "search results" });

		const payload = { ...basePayload, messages: [...basePayload.messages] };
		const events = await collectEvents(
			closeLastOutputItem(responseObject, payload, mcpToolsMapping, traceContext, log, alreadyCalledMcpIds)
		);
		const types = events.map((e) => e.type);

		expect(types).toContain("response.mcp_call_arguments.done");
		expect(types).toContain("response.mcp_call.completed");
		expect(types).toContain("response.output_item.done");
		expect(callMcpTool).toHaveBeenCalledWith(searchParams, "search", '{"q":"test"}', log);
	});

	it("closes mcp_approval_request output items", async () => {
		const responseObject = createMockResponseObject();
		const approvalReq: ResponseOutputItem.McpApprovalRequest = {
			type: "mcp_approval_request",
			id: "mcpr_1",
			name: "tool1",
			server_label: "server1",
			arguments: "{}",
		};
		responseObject.output.push(approvalReq);

		const events = await collectEvents(
			closeLastOutputItem(responseObject, { ...basePayload }, new Map(), traceContext, log)
		);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.output_item.done"]);
	});
});
