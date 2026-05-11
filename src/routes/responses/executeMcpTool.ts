import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type { PatchedResponseStreamEvent } from "../../openai_patch";
import type { McpServerParams } from "../../schemas.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Attributes, Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import { SEQUENCE_NUMBER_PLACEHOLDER, tracer, OTEL_GENAI_CAPTURE_TOOL_CONTENT } from "./types.js";
import { buildJsonAttribute, recordError } from "./utils.js";
import { callMcpTool } from "../../mcp.js";

export interface McpToolExecutionResult {
	events: PatchedResponseStreamEvent[];
	messages: ChatCompletionMessageParam[] | null;
}

/**
 * Execute an MCP tool call — agentic concern.
 * Calls the MCP tool, emits completion/failure events, and returns messages to append to the payload.
 * Does NOT mutate the payload directly; the caller is responsible for appending messages.
 */
export async function executeMcpCall(
	mcpCallItem: ResponseOutputItem.McpCall,
	outputIndex: number,
	mcpToolsMapping: Map<string, McpServerParams>,
	traceContext: Context,
	log: Logger
): Promise<McpToolExecutionResult> {
	const toolParams = mcpToolsMapping.get(mcpCallItem.name);
	if (!toolParams) {
		throw new Error(`MCP tool '${mcpCallItem.name}' not found in tools mapping`);
	}

	const toolSpanAttributes: Attributes = {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": mcpCallItem.name,
		"gen_ai.tool.type": "extension",
		"gen_ai.tool.call.id": mcpCallItem.id,
		"mcp.server_label": mcpCallItem.server_label,
	};
	if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
		toolSpanAttributes["gen_ai.tool.call.arguments"] = buildJsonAttribute(mcpCallItem.arguments);
	}
	const toolSpan = tracer.startSpan("gen_ai.execute_tool", { attributes: toolSpanAttributes }, traceContext);

	const events: PatchedResponseStreamEvent[] = [];

	let toolResult;
	try {
		toolResult = await callMcpTool(toolParams, mcpCallItem.name, mcpCallItem.arguments, log);
	} catch (error) {
		recordError(toolSpan, error);
		toolSpan.end();
		throw error;
	}

	if (toolResult.error) {
		mcpCallItem.error = toolResult.error;
		toolSpan.setAttribute("tool.status", "error");
		toolSpan.setAttribute("tool.error", toolResult.error);
		recordError(toolSpan, new Error(toolResult.error));
		events.push({
			type: "response.mcp_call.failed",
			item_id: mcpCallItem.id as string,
			output_index: outputIndex,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		});
	} else {
		mcpCallItem.output = toolResult.output;
		toolSpan.setAttribute("tool.status", "ok");
		if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
			toolSpan.setAttribute("gen_ai.tool.call.result", buildJsonAttribute(toolResult.output));
		}
		events.push({
			type: "response.mcp_call.completed",
			item_id: mcpCallItem.id as string,
			output_index: outputIndex,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		});
	}
	toolSpan.end();

	events.push({
		type: "response.output_item.done",
		output_index: outputIndex,
		item: mcpCallItem,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	});

	let messages: ChatCompletionMessageParam[] | null = null;
	if (!mcpCallItem.error) {
		messages = [
			{
				role: "assistant" as const,
				tool_calls: [
					{
						id: mcpCallItem.id,
						type: "function" as const,
						function: {
							name: mcpCallItem.name,
							arguments: mcpCallItem.arguments,
						},
					},
				],
			},
			{
				role: "tool" as const,
				tool_call_id: mcpCallItem.id,
				content: mcpCallItem.output ?? "",
			},
		];
	} else {
		log.warn(
			{
				item_id: mcpCallItem.id,
				error: mcpCallItem.error,
			},
			"Not adding MCP tool output to payload due to error"
		);
	}

	return { events, messages };
}
