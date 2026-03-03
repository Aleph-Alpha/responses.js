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

// Mock generateUniqueId
vi.mock("../../lib/generateUniqueId.js", () => ({
	generateUniqueId: vi.fn().mockImplementation((prefix) => `${prefix}_test123`),
}));

// Mock mcp.js
vi.mock("../../mcp.js", () => ({
	callMcpTool: vi.fn(),
	connectMcpServer: vi.fn(),
}));

import { listMcpToolsStream, callApprovedMCPToolStream } from "./mcpStream.js";
import { connectMcpServer, callMcpTool } from "../../mcp.js";
import { createMockResponseObject, createMockLogger, collectEvents } from "./__test_helpers__/mocks.js";
import type { McpServerParams } from "../../schemas.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { Context } from "@opentelemetry/api";

const log = createMockLogger() as any;

describe("listMcpToolsStream", () => {
	const traceContext = {} as Context;
	const mcpTool: McpServerParams = {
		server_label: "test-server",
		server_url: "http://localhost:3001",
		type: "mcp",
		allowed_tools: null,
		headers: null,
		require_approval: "always",
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("yields correct event sequence on success", async () => {
		const mockClient = {
			listTools: vi.fn().mockResolvedValue({
				tools: [
					{
						name: "search",
						inputSchema: { type: "object" },
						description: "Search tool",
						annotations: undefined,
					},
				],
			}),
		};
		(connectMcpServer as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

		const responseObject = createMockResponseObject();
		const events = await collectEvents(listMcpToolsStream(mcpTool, responseObject, traceContext, log));
		const types = events.map((e) => e.type);

		expect(types).toEqual([
			"response.output_item.added",
			"response.mcp_list_tools.in_progress",
			"response.mcp_list_tools.completed",
			"response.output_item.done",
		]);
	});

	it("yields failed event and throws on connection error", async () => {
		(connectMcpServer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"));

		const responseObject = createMockResponseObject();

		await expect(collectEvents(listMcpToolsStream(mcpTool, responseObject, traceContext, log))).rejects.toThrow(
			"Failed to list tools from MCP server 'test-server'"
		);
	});
});

describe("callApprovedMCPToolStream", () => {
	const traceContext = {} as Context;
	const basePayload: ChatCompletionCreateParamsStreaming = {
		model: "test-model",
		messages: [{ role: "user", content: "Hello" }],
		stream: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws when approval request is not found", async () => {
		const responseObject = createMockResponseObject();
		await expect(
			collectEvents(
				callApprovedMCPToolStream(
					"req_123",
					"mcp_123",
					undefined,
					{},
					responseObject,
					{ ...basePayload },
					traceContext,
					log
				)
			)
		).rejects.toThrow("MCP approval request 'req_123' not found");
	});

	it("yields success events on successful MCP call", async () => {
		const approvalRequest = {
			type: "mcp_approval_request" as const,
			id: "mcpr_123",
			name: "search",
			server_label: "test-server",
			arguments: '{"q":"test"}',
		};
		const mcpToolsMapping: Record<string, McpServerParams> = {
			search: {
				server_label: "test-server",
				server_url: "http://localhost:3001",
				type: "mcp",
				allowed_tools: null,
				headers: null,
				require_approval: "always",
			},
		};

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "result" });

		const responseObject = createMockResponseObject();
		const payload = { ...basePayload, messages: [...basePayload.messages] };
		const events = await collectEvents(
			callApprovedMCPToolStream(
				"mcpr_123",
				"mcp_123",
				approvalRequest,
				mcpToolsMapping,
				responseObject,
				payload,
				traceContext,
				log
			)
		);
		const types = events.map((e) => e.type);

		expect(types).toContain("response.output_item.added");
		expect(types).toContain("response.mcp_call.in_progress");
		expect(types).toContain("response.mcp_call.completed");
		expect(types).toContain("response.output_item.done");
		// Payload messages updated
		expect(payload.messages.length).toBe(3);
	});

	it("yields failed event on MCP tool error", async () => {
		const approvalRequest = {
			type: "mcp_approval_request" as const,
			id: "mcpr_123",
			name: "search",
			server_label: "test-server",
			arguments: "{}",
		};
		const mcpToolsMapping: Record<string, McpServerParams> = {
			search: {
				server_label: "test-server",
				server_url: "http://localhost:3001",
				type: "mcp",
				allowed_tools: null,
				headers: null,
				require_approval: "always",
			},
		};

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "tool failed" });

		const responseObject = createMockResponseObject();
		const events = await collectEvents(
			callApprovedMCPToolStream(
				"mcpr_123",
				"mcp_123",
				approvalRequest,
				mcpToolsMapping,
				responseObject,
				{ ...basePayload },
				traceContext,
				log
			)
		);
		const types = events.map((e) => e.type);

		expect(types).toContain("response.mcp_call.failed");
		expect(types).toContain("response.output_item.done");
	});
});
