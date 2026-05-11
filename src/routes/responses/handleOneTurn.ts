import { OpenAI } from "openai";
import { Agent } from "undici";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { PatchedResponseStreamEvent } from "../../openai_patch";
import type { McpServerParams } from "../../schemas.js";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import { type IncompleteResponse, tracer } from "./types.js";
import { recordError } from "./utils.js";
import { modelCallCounter, modelCallDuration } from "../../lib/metrics.js";
import { config } from "../../lib/config.js";
import { parseChatCompletionsStream } from "./chatCompletionsParser.js";
import { parseResponsesApiStream } from "./responsesApiParser.js";
import { buildResponsesEvents, type ReasoningSummaryMode } from "./responsesEventBuilder.js";

// Shared undici Agent per worker process — avoids creating a new connection pool per request.
const sharedDispatcher = new Agent({
	allowH2: true,
	connections: config.upstreamMaxConnections,
	pipelining: 1,
	keepAliveTimeout: config.upstreamKeepAliveTimeoutMs,
	connectTimeout: config.upstreamConnectTimeoutMs,
});

/*
 * Call LLM and stream the response.
 */
export async function* handleOneTurnStream(
	apiKey: string | undefined,
	payload: ChatCompletionCreateParamsStreaming,
	responseObject: IncompleteResponse,
	mcpToolsMapping: Map<string, McpServerParams>,
	defaultHeaders: Record<string, string>,
	traceContext: Context,
	log: Logger,
	reasoningSummaryMode: ReasoningSummaryMode = null,
	signal?: AbortSignal
): AsyncGenerator<PatchedResponseStreamEvent> {
	// Collect IDs of mcp_call items already executed in previous turns
	const alreadyCalledMcpIds = new Set(
		responseObject.output.filter((item) => item.type === "mcp_call").map((item) => item.id)
	);

	const llmSpan = tracer.startSpan(
		"gen_ai.chat",
		{
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": payload.model,
				"gen_ai.request.max_tokens": payload.max_tokens ?? undefined,
				"gen_ai.request.temperature": payload.temperature ?? undefined,
				"gen_ai.request.top_p": payload.top_p ?? undefined,
			},
		},
		traceContext
	);

	const client = new OpenAI({
		baseURL: config.openaiBaseUrl,
		apiKey: apiKey,
		defaultHeaders,
		maxRetries: 5,
		fetchOptions: {
			dispatcher: sharedDispatcher,
		},
	});
	const modelCallStart = performance.now();
	let modelCallStatusCode = 200;
	try {
		const stream = await client.chat.completions.create(payload, {
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(config.llmRequestTimeoutMs)])
				: AbortSignal.timeout(config.llmRequestTimeoutMs),
		});

		const llmEvents =
			config.backendMode === "responses_api"
				? parseResponsesApiStream(stream, log)
				: parseChatCompletionsStream(stream, log);

		for await (const event of buildResponsesEvents(
			llmEvents,
			responseObject,
			mcpToolsMapping,
			traceContext,
			log,
			alreadyCalledMcpIds,
			reasoningSummaryMode
		)) {
			yield event;
		}
	} catch (error) {
		if (error instanceof OpenAI.APIError) {
			modelCallStatusCode = error.status ?? 500;
			const detail = error.error?.message ?? (error.status ? null : error.message);
			error.message = detail
				? `Inference backend error (HTTP ${error.status ?? "unknown"}): ${detail}`
				: `Inference backend returned HTTP ${error.status ?? "unknown"} with no details`;
		} else {
			modelCallStatusCode = 500;
		}
		recordError(llmSpan, error);
		throw error;
	} finally {
		const modelCallDurationSeconds = (performance.now() - modelCallStart) / 1000;
		const metricAttrs = { status_code: modelCallStatusCode, model_name: payload.model };
		modelCallCounter.add(1, metricAttrs);
		modelCallDuration.record(modelCallDurationSeconds, metricAttrs);
		if (responseObject.usage) {
			llmSpan.setAttributes({
				"gen_ai.usage.input_tokens": responseObject.usage.input_tokens,
				"gen_ai.usage.output_tokens": responseObject.usage.output_tokens,
			});
		}
		llmSpan.end();
	}
}
