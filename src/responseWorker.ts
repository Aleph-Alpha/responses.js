import { parentPort, type MessagePort } from "node:worker_threads";
import pino from "pino";
import type { CreateResponseParams } from "./schemas.js";
import type { ValidatedRequest } from "./middleware/validation.js";
import { runCreateResponseStream } from "./routes/responses.js";

if (!parentPort) {
	throw new Error("This file must be run as a Worker thread");
}

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

parentPort.on(
	"message",
	async (msg: { type: string; data: { body: CreateResponseParams; headers: Record<string, string> }; port: MessagePort }) => {
		if (msg.type !== "task") return;

		const { data, port } = msg;
		const log = pino({ level: LOG_LEVEL });

		const mockReq = {
			body: data.body,
			headers: data.headers,
			log,
		} as unknown as ValidatedRequest<CreateResponseParams>;

		try {
			const events = runCreateResponseStream(mockReq);

			for await (const event of events) {
				port.postMessage({ type: "event", data: event });
			}
			port.postMessage({ type: "done" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			port.postMessage({ type: "error", message });
		}
	}
);
