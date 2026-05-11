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
}));

import { executeMcpCall } from "./executeMcpTool.js";
import { callMcpTool } from "../../mcp.js";
import { createMockLogger } from "./__test_helpers__/mocks.js";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";

describe("executeMcpCall", () => {
	const traceContext = {} as Context;
	const log = createMockLogger() as unknown as Logger;

	const searchParams = {
		server_label: "test-server",
		server_url: "http://localhost:3001",
		type: "mcp" as const,
		allowed_tools: null,
		headers: null,
		require_approval: "never" as const,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("executes MCP tool and returns completed events and messages", async () => {
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: '{"q":"test"}',
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "search results" });

		const result = await executeMcpCall(mcpCall, 0, mcpToolsMapping, traceContext, log);

		expect(callMcpTool).toHaveBeenCalledWith(searchParams, "search", '{"q":"test"}', log);

		const types = result.events.map((e) => e.type);
		expect(types).toContain("response.mcp_call.completed");
		expect(types).toContain("response.output_item.done");

		expect(mcpCall.output).toBe("search results");

		expect(result.messages).not.toBeNull();
		expect(result.messages).toHaveLength(2);
		expect(result.messages![0]).toMatchObject({ role: "assistant" });
		expect(result.messages![1]).toMatchObject({ role: "tool", tool_call_id: "mcp_1", content: "search results" });
	});

	it("handles MCP tool error and returns failed events without messages", async () => {
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: "{}",
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "tool failed" });

		const result = await executeMcpCall(mcpCall, 0, mcpToolsMapping, traceContext, log);

		const types = result.events.map((e) => e.type);
		expect(types).toContain("response.mcp_call.failed");
		expect(types).toContain("response.output_item.done");

		expect(mcpCall.error).toBe("tool failed");
		expect(result.messages).toBeNull();
	});

	it("throws when tool is not in mapping", async () => {
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "unknown_tool",
			server_label: "test-server",
			arguments: "{}",
		};

		await expect(executeMcpCall(mcpCall, 0, new Map(), traceContext, log)).rejects.toThrow(
			"MCP tool 'unknown_tool' not found in tools mapping"
		);
	});

	it("throws when callMcpTool throws", async () => {
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: "{}",
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);

		(callMcpTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));

		await expect(executeMcpCall(mcpCall, 0, mcpToolsMapping, traceContext, log)).rejects.toThrow(
			"connection refused"
		);
	});

	it("uses correct output_index in events", async () => {
		const mcpCall: ResponseOutputItem.McpCall = {
			type: "mcp_call",
			id: "mcp_1",
			name: "search",
			server_label: "test-server",
			arguments: "{}",
		};
		const mcpToolsMapping = new Map([["search", searchParams]]);

		(callMcpTool as ReturnType<typeof vi.fn>).mockResolvedValue({ output: "result" });

		const result = await executeMcpCall(mcpCall, 3, mcpToolsMapping, traceContext, log);

		for (const event of result.events) {
			expect((event as Record<string, unknown>).output_index).toBe(3);
		}
	});
});
