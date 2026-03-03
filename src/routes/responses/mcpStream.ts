import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type { PatchedResponseStreamEvent } from "../../openai_patch";
import type { McpServerParams, McpApprovalRequestParams } from "../../schemas.js";
import { generateUniqueId } from "../../lib/generateUniqueId.js";
import { callMcpTool, connectMcpServer } from "../../mcp.js";
import type { Context, Attributes } from "@opentelemetry/api";
import type { Logger } from "pino";
import {
	type IncompleteResponse,
	SEQUENCE_NUMBER_PLACEHOLDER,
	tracer,
	OTEL_GENAI_CAPTURE_TOOL_CONTENT,
} from "./types.js";
import { buildJsonAttribute, recordError } from "./utils.js";

export async function* listMcpToolsStream(
	tool: McpServerParams,
	responseObject: IncompleteResponse,
	traceContext: Context,
	log: Logger
): AsyncGenerator<PatchedResponseStreamEvent> {
	const span = tracer.startSpan(
		"gen_ai.execute_tool",
		{
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "mcp.list_tools",
				"gen_ai.tool.type": "extension",
				"mcp.server_label": tool.server_label,
			},
		},
		traceContext
	);
	const outputObject: ResponseOutputItem.McpListTools = {
		id: generateUniqueId("mcpl"),
		type: "mcp_list_tools",
		server_label: tool.server_label,
		tools: [],
	};
	responseObject.output.push(outputObject);

	yield {
		type: "response.output_item.added",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.mcp_list_tools.in_progress",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	try {
		const mcp = await connectMcpServer(tool, log);
		const mcpTools = await mcp.listTools();
		yield {
			type: "response.mcp_list_tools.completed",
			item_id: outputObject.id,
			output_index: responseObject.output.length - 1,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
		outputObject.tools = mcpTools.tools.map((mcpTool) => ({
			input_schema: mcpTool.inputSchema,
			name: mcpTool.name,
			annotations: mcpTool.annotations,
			description: mcpTool.description,
		}));
		span.setAttribute("mcp.tools.count", outputObject.tools.length);
		yield {
			type: "response.output_item.done",
			output_index: responseObject.output.length - 1,
			item: outputObject,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} catch (error) {
		const errorMessage = `Failed to list tools from MCP server '${tool.server_label}': ${error instanceof Error ? error.message : "Unknown error"}`;
		log.error({ err: error, server_label: tool.server_label }, "Failed to list MCP tools");
		recordError(span, error);
		yield {
			type: "response.mcp_list_tools.failed",
			item_id: outputObject.id,
			output_index: responseObject.output.length - 1,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
		throw new Error(errorMessage);
	} finally {
		span.end();
	}
}

/*
 * Perform an approved MCP tool call and stream the response.
 */
export async function* callApprovedMCPToolStream(
	approval_request_id: string,
	mcpCallId: string,
	approvalRequest: McpApprovalRequestParams | undefined,
	mcpToolsMapping: Map<string, McpServerParams>,
	responseObject: IncompleteResponse,
	payload: ChatCompletionCreateParamsStreaming,
	traceContext: Context,
	log: Logger
): AsyncGenerator<PatchedResponseStreamEvent> {
	if (!approvalRequest) {
		throw new Error(`MCP approval request '${approval_request_id}' not found`);
	}

	const outputObject: ResponseOutputItem.McpCall = {
		type: "mcp_call",
		id: mcpCallId,
		name: approvalRequest.name,
		server_label: approvalRequest.server_label,
		arguments: approvalRequest.arguments,
	};
	responseObject.output.push(outputObject);

	// Response output item added event
	yield {
		type: "response.output_item.added",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.mcp_call.in_progress",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	const toolParams = mcpToolsMapping.get(approvalRequest.name);
	if (!toolParams) {
		throw new Error(`MCP tool '${approvalRequest.name}' not found in tools mapping`);
	}

	const toolSpanAttributes: Attributes = {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": approvalRequest.name,
		"gen_ai.tool.type": "extension",
		"gen_ai.tool.call.id": outputObject.id,
		"mcp.server_label": approvalRequest.server_label,
	};
	if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
		toolSpanAttributes["gen_ai.tool.call.arguments"] = buildJsonAttribute(approvalRequest.arguments);
	}
	const toolSpan = tracer.startSpan("gen_ai.execute_tool", { attributes: toolSpanAttributes }, traceContext);
	let toolResult;
	try {
		toolResult = await callMcpTool(toolParams, approvalRequest.name, approvalRequest.arguments, log);
	} catch (error) {
		recordError(toolSpan, error);
		toolSpan.end();
		throw error;
	}

	if (toolResult.error) {
		outputObject.error = toolResult.error;
		toolSpan.setAttribute("tool.status", "error");
		toolSpan.setAttribute("tool.error", toolResult.error);
		recordError(toolSpan, new Error(toolResult.error));
		yield {
			type: "response.mcp_call.failed",
			item_id: outputObject.id,
			output_index: responseObject.output.length - 1,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} else {
		outputObject.output = toolResult.output;
		toolSpan.setAttribute("tool.status", "ok");
		if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
			toolSpan.setAttribute("gen_ai.tool.call.result", buildJsonAttribute(toolResult.output));
		}
		yield {
			type: "response.mcp_call.completed",
			item_id: outputObject.id,
			output_index: responseObject.output.length - 1,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	}

	yield {
		type: "response.output_item.done",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	// Updating the payload for next LLM call
	payload.messages.push(
		{
			role: "assistant",
			tool_calls: [
				{
					id: outputObject.id,
					type: "function",
					function: {
						name: outputObject.name,
						arguments: outputObject.arguments,
						// Hacky: type is not correct in inference.js. Will fix it but in the meantime we need to cast it.
						// TODO: fix it in the inference.js package. Should be "arguments" and not "parameters".
					},
				},
			],
		},
		{
			role: "tool",
			tool_call_id: outputObject.id,
			content: outputObject.output ? outputObject.output : outputObject.error ? `Error: ${outputObject.error}` : "",
		}
	);

	toolSpan.end();
}
