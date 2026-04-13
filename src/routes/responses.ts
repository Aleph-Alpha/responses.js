import { type Request, type Response as ExpressResponse } from "express";
import type { ValidatedRequest } from "../middleware/validation.js";
import type { CreateResponseParams } from "../schemas.js";
import { createResponseParamsSchema } from "../schemas.js";
import { generateUniqueId } from "../lib/generateUniqueId.js";
import { trace } from "@opentelemetry/api";
import type { Response } from "openai/resources/responses/responses";
import type { PatchedResponseStreamEvent } from "../openai_patch";
import { type IncompleteResponse, tracer } from "./responses/types.js";
import { getRequestTraceContext, recordError, writeWithBackpressure } from "./responses/utils.js";
import { innerRunStream } from "./responses/innerStream.js";
import { workerPool } from "../lib/workerPool.js";

export const postCreateResponse = async (
	req: Request,
	res: ExpressResponse
): Promise<void> => {
	const log = req.log;

	if (workerPool) {
		// Stream request body directly to worker — the main thread never buffers
		// the full body, only forwarding chunks with zero-copy transfer.
		const results = workerPool.execute({
			bodyStream: req,
			headers: req.headers as Record<string, string | string[] | undefined>,
		});

		// First yielded message is meta with stream flag (sent by worker after parsing)
		const { value: meta } = await results.next();
		const isStream = meta?.type === "meta" && !!meta.stream;

		const events = results as AsyncGenerator<PatchedResponseStreamEvent>;
		return sendResponse(res, log, events, isStream);
	}

	// Non-worker fallback: buffer and parse on main thread
	const rawBody = await readBody(req);
	let parsed: CreateResponseParams;
	try {
		parsed = createResponseParamsSchema.parse(JSON.parse(rawBody));
	} catch (error) {
		res.status(400).json({ success: false, error: error instanceof Error ? error.message : "Invalid JSON" });
		return;
	}
	const mockReq = { body: parsed, headers: req.headers, log } as unknown as ValidatedRequest<CreateResponseParams>;
	const events = runCreateResponseStream(mockReq);
	return sendResponse(res, log, events, !!parsed.stream);
};

/** Read body from a request — handles both buffered (tests) and streamed (production) cases. */
async function readBody(req: Request): Promise<string> {
	if (Buffer.isBuffer(req.body)) return req.body.toString("utf-8");
	if (typeof req.body === "string") return req.body;
	const chunks: Buffer[] = [];
	for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function sendResponse(
	res: ExpressResponse,
	log: Request["log"],
	events: AsyncGenerator<PatchedResponseStreamEvent>,
	isStream: boolean
): Promise<void> {
	if (isStream) {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		log.debug("Processing streaming response");
		for await (const event of events) {
			log.debug({ event_type: event.type, seq: event.sequence_number }, "Stream event");
			await writeWithBackpressure(res, `data: ${JSON.stringify(event)}\n\n`);
		}
		res.end();
	} else {
		log.debug("Processing non-streaming response");
		for await (const event of events) {
			if (event.type === "response.completed" || event.type === "response.failed") {
				log.debug({ event_type: event.type }, "Response completed");
				res.json(event.response);
			}
		}
	}
}

/*
 * Top-level stream.
 *
 * Handles response lifecycle + execute inner logic (MCP list tools, MCP tool calls, LLM call, etc.).
 * Handles sequenceNumber by overwriting it in the events.
 */
export async function* runCreateResponseStream(
	req: ValidatedRequest<CreateResponseParams>
): AsyncGenerator<PatchedResponseStreamEvent> {
	const requestContext = getRequestTraceContext(req);
	const requestSpan = tracer.startSpan(
		"responses.create",
		{
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": req.body.model,
				"gen_ai.request.max_tokens": req.body.max_output_tokens ?? undefined,
				"gen_ai.request.temperature": req.body.temperature ?? undefined,
				"gen_ai.request.top_p": req.body.top_p ?? undefined,
				"gen_ai.response.id": undefined,
			},
		},
		requestContext
	);
	const traceContext = trace.setSpan(requestContext, requestSpan);

	let sequenceNumber = 0;
	// Prepare response object that will be iteratively populated
	const responseObject: IncompleteResponse = {
		created_at: Math.floor(new Date().getTime() / 1000),
		error: null,
		id: generateUniqueId("resp"),
		instructions: req.body.instructions,
		max_output_tokens: req.body.max_output_tokens,
		metadata: req.body.metadata,
		model: req.body.model,
		object: "response",
		output: [],
		// parallel_tool_calls: req.body.parallel_tool_calls,
		status: "in_progress",
		text: req.body.text,
		tool_choice: req.body.tool_choice ?? "auto",
		tools: req.body.tools ?? [],
		temperature: req.body.temperature,
		top_p: req.body.top_p,
		usage: {
			input_tokens: 0,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 0,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 0,
		},
	};
	requestSpan.setAttribute("gen_ai.response.id", responseObject.id);

	// Response created event
	yield {
		type: "response.created",
		response: responseObject as Response,
		sequence_number: sequenceNumber++,
	};

	// Response in progress event
	yield {
		type: "response.in_progress",
		response: responseObject as Response,
		sequence_number: sequenceNumber++,
	};

	try {
		// Any events (LLM call, MCP call, list tools, etc.)
		try {
			for await (const event of innerRunStream(req, responseObject, traceContext)) {
				yield { ...event, sequence_number: sequenceNumber++ };
			}
		} catch (error) {
			// Error event => stop
			req.log.error({ err: error }, "Stream error");

			const message =
				typeof error === "object" &&
				error &&
				"message" in error &&
				typeof (error as { message: unknown }).message === "string"
					? (error as { message: string }).message
					: "An error occurred in stream";

			responseObject.status = "failed";
			responseObject.error = {
				code: "server_error",
				message,
			};
			recordError(requestSpan, error);
			yield {
				type: "response.failed",
				response: responseObject as Response,
				sequence_number: sequenceNumber++,
			};
			return;
		}

		// Response completed event
		responseObject.status = "completed";
		if (responseObject.usage) {
			requestSpan.setAttributes({
				"gen_ai.usage.input_tokens": responseObject.usage.input_tokens,
				"gen_ai.usage.output_tokens": responseObject.usage.output_tokens,
			});
		}
		requestSpan.setAttributes({
			"gen_ai.response.model": responseObject.model,
			"response.status": responseObject.status,
		});
		yield {
			type: "response.completed",
			response: responseObject as Response,
			sequence_number: sequenceNumber++,
		};
	} finally {
		requestSpan.end();
	}
}
