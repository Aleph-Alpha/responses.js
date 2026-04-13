import { parentPort, type MessagePort } from "node:worker_threads";
import pino from "pino";
import type { CreateResponseParams } from "./schemas.js";
import { createResponseParamsSchema } from "./schemas.js";
import type { ValidatedRequest } from "./middleware/validation.js";
import { runCreateResponseStream } from "./routes/responses.js";

if (!parentPort) {
	throw new Error("This file must be run as a Worker thread");
}

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

parentPort.on(
	"message",
	(msg: { type: string; data: { headers: Record<string, string> }; port: MessagePort }) => {
		if (msg.type !== "task") return;

		const { data, port } = msg;
		const log = pino({ level: LOG_LEVEL });

		// Collect body chunks streamed from the main thread
		const chunks: Buffer[] = [];

		port.on("message", async (bodyMsg: { type: string; data?: ArrayBuffer }) => {
			if (bodyMsg.type === "chunk") {
				chunks.push(Buffer.from(bodyMsg.data!));
				return;
			}

			if (bodyMsg.type !== "end") return;

			try {
				const rawBody = Buffer.concat(chunks).toString("utf-8");
				const body: CreateResponseParams = createResponseParamsSchema.parse(JSON.parse(rawBody));

				// Send meta first so the main thread knows the response format
				port.postMessage({ type: "meta", data: { type: "meta", stream: !!body.stream } });

				const mockReq = {
					body: body,
					headers: data.headers,
					log,
				} as unknown as ValidatedRequest<CreateResponseParams>;

				const events = runCreateResponseStream(mockReq);

				for await (const event of events) {
					port.postMessage({ type: "event", data: event });
				}
				port.postMessage({ type: "done" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				port.postMessage({ type: "error", message });
			}
		});
	}
);
