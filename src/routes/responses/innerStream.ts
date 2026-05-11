import type { ValidatedRequest } from "../../middleware/validation.js";
import type { CreateResponseParams, McpServerParams, McpApprovalRequestParams } from "../../schemas.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { FunctionParameters } from "openai/resources/shared.js";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type { PatchedResponseStreamEvent } from "../../openai_patch";
import type { Attributes, Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import { type IncompleteResponse, tracer, OTEL_GENAI_CAPTURE_TOOL_CONTENT } from "./types.js";
import { NOT_FORWARDED_HEADERS, buildJsonAttribute } from "./utils.js";
import { config } from "../../lib/config.js";
import { formatInputToMessages } from "./messageFormatting.js";
import { buildLLMPayload } from "./payloadBuilder.js";
import { handleOneTurnStream } from "./handleOneTurn.js";
import { listMcpToolsStream, callApprovedMCPToolStream } from "./mcpStream.js";
import { executeMcpCall } from "./executeMcpTool.js";
import type { ReasoningSummaryMode } from "./responsesEventBuilder.js";

export async function* innerRunStream(
	req: ValidatedRequest<CreateResponseParams>,
	responseObject: IncompleteResponse,
	traceContext: Context,
	signal?: AbortSignal,
	log: Logger = req.log
): AsyncGenerator<PatchedResponseStreamEvent> {
	// Retrieve API key from headers
	const apiKey = req.headers.authorization?.split(" ")[1];
	if (!apiKey) {
		throw new Error("Unauthorized: missing or invalid Authorization header");
	}

	// Forward headers (except authorization handled separately)
	const defaultHeaders = Object.fromEntries(
		Object.entries(req.headers).filter(([key]) => !NOT_FORWARDED_HEADERS.has(key.toLowerCase()))
	) as Record<string, string>;

	// Trace function tool calls provided by the client in input history
	if (Array.isArray(req.body.input)) {
		for (const item of req.body.input) {
			if (item.type !== "function_call") {
				continue;
			}

			const matchingOutput = req.body.input.find(
				(inputItem) => inputItem.type === "function_call_output" && inputItem.call_id === item.call_id
			) as Extract<NonNullable<CreateResponseParams["input"]>[number], { type: "function_call_output" }> | undefined;

			const functionCallSpanAttributes: Attributes = {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.type": "function",
				"gen_ai.tool.call.id": item.call_id,
				"gen_ai.tool.name": item.name ?? "unknown_function",
			};

			if (OTEL_GENAI_CAPTURE_TOOL_CONTENT) {
				if (item.arguments) {
					functionCallSpanAttributes["gen_ai.tool.call.arguments"] = buildJsonAttribute(item.arguments);
				}
				if (matchingOutput?.output) {
					functionCallSpanAttributes["gen_ai.tool.call.result"] = buildJsonAttribute(matchingOutput.output);
				}
			}

			const functionCallSpan = tracer.startSpan(
				"gen_ai.execute_tool",
				{ attributes: functionCallSpanAttributes },
				traceContext
			);
			functionCallSpan.setAttribute("tool.status", matchingOutput ? "ok" : "requested");
			functionCallSpan.end();
		}
	}

	// List MCP tools from server (if required) + prepare tools for the LLM
	let tools: ChatCompletionTool[] | undefined = [];
	const mcpToolsMapping = new Map<string, McpServerParams>();
	if (req.body.tools) {
		for (const tool of req.body.tools) {
			switch (tool.type) {
				case "function":
					tools?.push({
						type: tool.type,
						function: {
							name: tool.name,
							parameters: tool.parameters,
							description: tool.description,
							strict: tool.strict,
						},
					});
					break;
				case "mcp": {
					let mcpListTools: ResponseOutputItem.McpListTools | undefined;

					// If MCP list tools is already in the input, use it
					if (Array.isArray(req.body.input)) {
						for (const item of req.body.input) {
							if (item.type === "mcp_list_tools" && item.server_label === tool.server_label) {
								mcpListTools = item;
								log.debug({ server_label: tool.server_label }, "Using MCP list tools from input");
								break;
							}
						}
					}
					// Otherwise, list tools from MCP server
					if (!mcpListTools) {
						for await (const event of listMcpToolsStream(tool, responseObject, traceContext, log)) {
							yield event;
						}
						const lastOutput = responseObject.output.at(-1);
						if (!lastOutput || lastOutput.type !== "mcp_list_tools") {
							throw new Error(
								`Expected mcp_list_tools output after listMcpToolsStream, got ${lastOutput?.type ?? "undefined"}`
							);
						}
						mcpListTools = lastOutput;
					}

					// Only allowed tools are forwarded to the LLM
					const allowedTools = tool.allowed_tools
						? Array.isArray(tool.allowed_tools)
							? tool.allowed_tools
							: tool.allowed_tools.tool_names
						: [];
					if (mcpListTools?.tools) {
						for (const mcpTool of mcpListTools.tools) {
							const toolName = String(mcpTool.name);
							if (allowedTools.length === 0 || allowedTools.includes(toolName)) {
								tools?.push({
									type: "function" as const,
									function: {
										name: toolName,
										parameters: mcpTool.input_schema as FunctionParameters,
										description: mcpTool.description ?? undefined,
									},
								});
								mcpToolsMapping.set(toolName, tool);
							}
						}
						break;
					}
				}
			}
		}
	}
	if (tools.length === 0) {
		tools = undefined;
	}

	// Format input to Chat Completion format
	const messages = formatInputToMessages(req.body.input, req.body.instructions, log);

	// Prepare payload for the LLM
	const payload = buildLLMPayload(req.body, messages, tools);

	// Call the LLM until no new message is added to the payload.
	// New messages can be added if the LLM calls an MCP tool that is automatically run.
	// A maximum number of iterations is set to avoid infinite loops.
	// When agenticLoopDisabled is true, run exactly one turn with no MCP execution.
	if (config.agenticLoopDisabled) {
		for await (const event of handleOneTurnStream(
			apiKey,
			payload,
			responseObject,
			mcpToolsMapping,
			defaultHeaders,
			traceContext,
			log,
			req.body.reasoning?.summary ?? null,
			signal
		)) {
			yield event;
		}
	} else {
		yield* agenticLoop(
			apiKey,
			payload,
			responseObject,
			mcpToolsMapping,
			defaultHeaders,
			traceContext,
			log,
			req.body.reasoning?.summary ?? null,
			req.body.input,
			signal
		);
	}
}

async function* agenticLoop(
	apiKey: string,
	payload: ChatCompletionCreateParamsStreaming,
	responseObject: IncompleteResponse,
	mcpToolsMapping: Map<string, McpServerParams>,
	defaultHeaders: Record<string, string>,
	traceContext: Context,
	log: Logger,
	reasoningSummaryMode: ReasoningSummaryMode,
	input: CreateResponseParams["input"],
	signal?: AbortSignal
): AsyncGenerator<PatchedResponseStreamEvent> {
	// If MCP approval requests => execute them (no LLM call)
	if (Array.isArray(input)) {
		for (const item of input) {
			if (item.type === "mcp_approval_response" && item.approve) {
				const approvalRequest = input.find(
					(i) => i.type === "mcp_approval_request" && i.id === item.approval_request_id
				) as McpApprovalRequestParams | undefined;
				// Derive the mcp_call ID from the approval request ID (mcpr_<ID> -> mcp_<ID>)
				const mcpCallId = "mcp_" + item.approval_request_id.split("_")[1];
				const mcpCall = input.find((i) => i.type === "mcp_call" && i.id === mcpCallId);
				if (mcpCall) {
					// MCP call for that approval request has already been made, so we can skip it
					continue;
				}

				for await (const event of callApprovedMCPToolStream(
					item.approval_request_id,
					mcpCallId,
					approvalRequest,
					mcpToolsMapping,
					responseObject,
					payload,
					traceContext,
					log
				)) {
					yield event;
				}
			}
		}
	}

	let previousMessageCount: number;
	// Set to True if one of the conditions are detected:
	// - there is a function call in the output without a corresponding function_call_output in the input
	// - there is an MCP call in the output requesting approval without a corresponding approval_response in the input
	let hasUserTask = false;
	let currentMessageCount = payload.messages.length;
	const MAX_ITERATIONS = config.maxToolIterations;
	let iterations = 0;
	const executedMcpIds = new Set(
		responseObject.output.filter((item) => item.type === "mcp_call").map((item) => item.id)
	);
	do {
		previousMessageCount = currentMessageCount;

		for await (const event of handleOneTurnStream(
			apiKey,
			payload,
			responseObject,
			mcpToolsMapping,
			defaultHeaders,
			traceContext,
			log,
			reasoningSummaryMode,
			signal
		)) {
			yield event;
		}

		// Execute MCP tool if the last output is an unexecuted mcp_call
		const lastItem = responseObject.output.at(-1);
		if (lastItem?.type === "mcp_call" && !executedMcpIds.has(lastItem.id)) {
			const result = await executeMcpCall(
				lastItem,
				responseObject.output.length - 1,
				mcpToolsMapping,
				traceContext,
				log
			);
			for (const event of result.events) {
				yield event;
			}
			if (result.messages) {
				payload.messages.push(...result.messages);
			}
			executedMcpIds.add(lastItem.id);
		}

		// Check if the model requested actions that need to be handled by the user/client:
		// - function_call without a corresponding function_call_output (matched by call_id)
		// - mcp_approval_request without a corresponding mcp_approval_response (matched by id/approval_request_id)
		const inputItems = Array.isArray(input) ? input : [];
		hasUserTask = responseObject.output.some((item) => {
			if (item.type === "function_call") {
				return !inputItems.some((i) => i.type === "function_call_output" && i.call_id === item.call_id);
			}
			if (item.type === "mcp_approval_request") {
				return !inputItems.some((i) => i.type === "mcp_approval_response" && i.approval_request_id === item.id);
			}
			return false;
		});

		currentMessageCount = payload.messages.length;
		iterations++;
	} while (
		currentMessageCount > previousMessageCount &&
		iterations < MAX_ITERATIONS &&
		!hasUserTask &&
		!signal?.aborted
	);
}
