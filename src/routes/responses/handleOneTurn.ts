import type { PatchedChatCompletionCreateParamsStreaming } from "../../openai_patch.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import { OpenAI } from "openai";
import { Agent } from "undici";
import type { PatchedResponseStreamEvent } from "../../openai_patch";
import type { McpServerParams } from "../../schemas.js";
import type { Attributes, Context } from "@opentelemetry/api";
import type { Logger } from "pino";
import { type IncompleteResponse, LANGFUSE_OBSERVATION_TYPE, tracer } from "./types.js";
import { recordError } from "./utils.js";
import { modelCallCounter, modelCallDuration } from "../../lib/metrics.js";
import { config } from "../../lib/config.js";
import { parseChatCompletionsStream } from "./chatCompletionsParser.js";
import { buildResponsesEvents, type ReasoningSummaryMode } from "./responsesEventBuilder.js";
import type { LLMOutputEvent, UsageEvent } from "./llmEvents.js";

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
	payload: PatchedChatCompletionCreateParamsStreaming,
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

	// With OTEL_GENAI_RECORD_USAGE on (standalone), this span is the one
	// observation per model call that carries its usage. Behind a caller that
	// records usage itself (Stateful Responses), it is a plain span without
	// usage, so Langfuse does not count the call twice.
	const recordUsageOnSpan = config.otelGenaiRecordUsage;
	const llmSpan = tracer.startSpan(
		"gen_ai.chat",
		{
			attributes: {
				[LANGFUSE_OBSERVATION_TYPE]: recordUsageOnSpan ? "generation" : "span",
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
		maxRetries: config.llmMaxRetries,
		fetchOptions: {
			dispatcher: sharedDispatcher,
		},
	});
	const modelCallStart = performance.now();
	let modelCallStatusCode = 200;
	// Usage of this call only. responseObject.usage sums all calls of the
	// response (agentic loop), so it must not go on this call's span.
	const callUsage: { last?: UsageEvent } = {};
	try {
		// The payload can carry `reasoning_effort: "none"`, which the openai SDK
		// types do not allow yet. The cast sends the value to the backend unchanged.
		const stream = await client.chat.completions.create(payload as ChatCompletionCreateParamsStreaming, {
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(config.llmRequestTimeoutMs)])
				: AbortSignal.timeout(config.llmRequestTimeoutMs),
		});

		const llmEvents = recordUsage(parseChatCompletionsStream(stream, log), callUsage);
		// TODO: switch to parseResponsesApiStream when backendMode is responses_api
		// const llmEvents =
		// 	config.backendMode === "responses_api"
		// 		? parseResponsesApiStream(stream, log)
		// 		: parseChatCompletionsStream(stream, log);

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
		if (recordUsageOnSpan && callUsage.last) {
			llmSpan.setAttributes(usageSpanAttributes(callUsage.last));
		}
		llmSpan.end();
	}
}

/*
 * Pass LLM events through unchanged, keeping the last usage event in `into`.
 */
async function* recordUsage(
	events: AsyncIterable<LLMOutputEvent>,
	into: { last?: UsageEvent }
): AsyncGenerator<LLMOutputEvent> {
	for await (const event of events) {
		if (event.type === "usage") {
			into.last = event;
		}
		yield event;
	}
}

/*
 * GenAI usage attributes for one model call. Langfuse reads
 * gen_ai.usage.reasoning.output_tokens as output_reasoning_tokens and
 * subtracts it from output, so the call's total is unchanged.
 */
export function usageSpanAttributes(usage: UsageEvent): Attributes {
	const attributes: Attributes = {
		"gen_ai.usage.input_tokens": usage.inputTokens,
		"gen_ai.usage.output_tokens": usage.outputTokens,
	};
	if (usage.reasoningTokens !== undefined) {
		attributes["gen_ai.usage.reasoning.output_tokens"] = usage.reasoningTokens;
	}
	return attributes;
}
