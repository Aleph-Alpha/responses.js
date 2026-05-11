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

import { finalizeLastOutputItem } from "./finalizeOutputItem.js";
import { createMockResponseObject, createMockLogger, collectEvents } from "./__test_helpers__/mocks.js";
import type {
	ResponseOutputMessage,
	ResponseFunctionToolCall,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import type { PatchedResponseReasoningItem } from "../../openai_patch.js";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";

describe("finalizeLastOutputItem", () => {
	const traceContext = {} as Context;
	const log = createMockLogger() as unknown as Logger;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does nothing when output is empty", async () => {
		const responseObject = createMockResponseObject();
		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
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

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
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

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.reasoning_text.done", "response.content_part.done", "response.output_item.done"]);
		expect(reasoning.status).toBe("completed");
	});

	it("closes reasoning summary events when requested", async () => {
		const responseObject = createMockResponseObject();
		const reasoning: PatchedResponseReasoningItem = {
			id: "rs_1",
			type: "reasoning",
			status: "in_progress",
			content: [],
			summary: [{ type: "summary_text", text: "thinking..." }],
		};
		responseObject.output.push(reasoning as unknown as ResponseOutputItem);

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log, new Set(), true));
		const types = events.map((e) => e.type);

		expect(types).toEqual([
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

	it("does not close reasoning summary events by default", async () => {
		const responseObject = createMockResponseObject();
		const reasoning: PatchedResponseReasoningItem = {
			id: "rs_1",
			type: "reasoning",
			status: "in_progress",
			content: [{ type: "reasoning_text", text: "thinking..." }],
			summary: [{ type: "summary_text", text: "thinking..." }],
		};
		responseObject.output.push(reasoning as unknown as ResponseOutputItem);

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.reasoning_text.done", "response.content_part.done", "response.output_item.done"]);
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

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.function_call_arguments.done", "response.output_item.done"]);
		expect(fc.status).toBe("completed");
	});

	it("emits mcp_call_arguments.done for new mcp_call items without executing", async () => {
		const responseObject = createMockResponseObject();
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: '{"q":"test"}',
		};
		responseObject.output.push(mcpCall);

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
		const types = events.map((e) => e.type);

		// Only emits arguments.done — execution and output_item.done are handled by executeMcpCall
		expect(types).toEqual(["response.mcp_call_arguments.done"]);
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

		const alreadyCalledMcpIds = new Set(["mcp_1"]);
		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log, alreadyCalledMcpIds));

		expect(events).toHaveLength(0);
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

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));
		const types = events.map((e) => e.type);

		expect(types).toEqual(["response.output_item.done"]);
	});

	it("is a no-op when the last output item is mcp_list_tools", async () => {
		const responseObject = createMockResponseObject();
		const listTools: ResponseOutputItem.McpListTools = {
			id: "mcpl_1",
			type: "mcp_list_tools",
			server_label: "test-server",
			tools: [],
		};
		responseObject.output.push(listTools);

		const events = await collectEvents(finalizeLastOutputItem(responseObject, traceContext, log));

		expect(events).toHaveLength(0);
	});
});
