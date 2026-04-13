import { Worker, MessageChannel, type MessagePort } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type { Readable } from "node:stream";
import { logger } from "./logger.js";

export interface WorkerTaskData {
	bodyStream: Readable;
	headers: Record<string, string | string[] | undefined>;
}

export type WorkerOutMessage =
	| { type: "meta"; data: Record<string, unknown> }
	| { type: "event"; data: Record<string, unknown> }
	| { type: "error"; message: string }
	| { type: "done" };

export class HttpError extends Error {
	constructor(
		public statusCode: number,
		public data: unknown
	) {
		super(`HTTP ${statusCode}`);
		this.name = "HttpError";
	}
}

function resolveWorkerPath(): string {
	const currentFile = fileURLToPath(import.meta.url);
	const currentDir = path.dirname(currentFile);
	const ext = path.extname(currentFile);
	const workerName = `responseWorker${ext}`;

	// In production (bundled by tsup): worker is in the same directory as the bundle
	const sameDirPath = path.join(currentDir, workerName);
	if (fs.existsSync(sameDirPath)) {
		return sameDirPath;
	}
	// In development (tsx): workerPool.ts is in src/lib/, worker is in src/
	return path.join(currentDir, "..", workerName);
}

export class WorkerPool {
	private workers: Worker[] = [];
	private available: Worker[] = [];
	private taskQueue: Array<(worker: Worker) => void> = [];
	private shuttingDown = false;
	private readonly poolSize: number;
	private readonly workerPath: string;
	private readonly isTs: boolean;

	constructor(poolSize?: number) {
		this.poolSize = poolSize ?? parseInt(process.env.WORKER_POOL_SIZE || String(os.cpus().length), 10);
		this.workerPath = resolveWorkerPath();
		this.isTs = this.workerPath.endsWith(".ts");

		logger.info({ poolSize: this.poolSize, workerPath: this.workerPath }, "Initializing worker pool");
		for (let i = 0; i < this.poolSize; i++) {
			this.spawnWorker();
		}
	}

	private spawnWorker(): void {
		if (this.shuttingDown) return;

		const worker = new Worker(this.workerPath, {
			...(this.isTs ? { execArgv: ["--import", "tsx"] } : {}),
		});

		worker.on("error", (err) => {
			logger.error({ err, threadId: worker.threadId }, "Worker thread error");
		});

		worker.on("exit", (code) => {
			if (this.shuttingDown) return;
			logger.warn({ code, threadId: worker.threadId }, "Worker exited unexpectedly, replacing");
			this.workers = this.workers.filter((w) => w !== worker);
			this.available = this.available.filter((w) => w !== worker);
			this.spawnWorker();
		});

		this.workers.push(worker);
		this.available.push(worker);
		this.drainQueue();
	}

	private acquireWorker(timeoutMs = 30_000): Promise<Worker> {
		const worker = this.available.pop();
		if (worker) {
			return Promise.resolve(worker);
		}
		return new Promise<Worker>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.taskQueue.indexOf(entry);
				if (idx !== -1) this.taskQueue.splice(idx, 1);
				logger.error({ timeoutMs, queueLength: this.taskQueue.length }, "Worker pool exhausted, rejecting request");
				reject(new HttpError(503, { error: { message: "Worker pool exhausted", type: "server_error" } }));
			}, timeoutMs);
			const entry = (w: Worker) => {
				clearTimeout(timer);
				resolve(w);
			};
			this.taskQueue.push(entry);
		});
	}

	private releaseWorker(worker: Worker): void {
		if (this.taskQueue.length > 0) {
			const resolve = this.taskQueue.shift()!;
			resolve(worker);
		} else {
			this.available.push(worker);
		}
	}

	private drainQueue(): void {
		while (this.taskQueue.length > 0 && this.available.length > 0) {
			const resolve = this.taskQueue.shift()!;
			const worker = this.available.pop()!;
			resolve(worker);
		}
	}

	async *execute(taskData: WorkerTaskData): AsyncGenerator<Record<string, unknown>> {
		const worker = await this.acquireWorker();
		const { port1, port2 } = new MessageChannel();

		try {
			worker.postMessage({ type: "task", data: { headers: taskData.headers }, port: port2 }, [port2]);

			// Stream body chunks to worker — each chunk is zero-copy transferred
			// so the main thread never holds the full body in memory.
			for await (const chunk of taskData.bodyStream) {
				const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
				port1.postMessage({ type: "chunk", data: ab }, [ab]);
			}
			port1.postMessage({ type: "end" });

			yield* this.readMessages(port1);
		} finally {
			port1.close();
			this.releaseWorker(worker);
		}
	}

	private async *readMessages(port: MessagePort): AsyncGenerator<Record<string, unknown>> {
		let waiting: ((msg: WorkerOutMessage | null) => void) | null = null;
		const buffer: Array<WorkerOutMessage | null> = [];

		const push = (msg: WorkerOutMessage | null): void => {
			if (waiting) {
				const resolve = waiting;
				waiting = null;
				resolve(msg);
			} else {
				buffer.push(msg);
			}
		};

		const pull = (): Promise<WorkerOutMessage | null> => {
			if (buffer.length > 0) {
				return Promise.resolve(buffer.shift()!);
			}
			return new Promise<WorkerOutMessage | null>((resolve) => {
				waiting = resolve;
			});
		};

		const onMessage = (msg: WorkerOutMessage): void => push(msg);
		const onClose = (): void => push(null);
		port.on("message", onMessage);
		port.on("close", onClose);

		try {
			while (true) {
				const msg = await pull();
			if (msg === null || msg.type === "done") return;
				if (msg.type === "error") throw new Error(msg.message);
				if (msg.type === "event" || msg.type === "meta") yield msg.data;
			}
		} finally {
			port.removeListener("message", onMessage);
			port.removeListener("close", onClose);
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		logger.info({ poolSize: this.workers.length }, "Shutting down worker pool");
		await Promise.all(this.workers.map((w) => w.terminate()));
		this.workers = [];
		this.available = [];
	}
}

const poolSize = parseInt(process.env.WORKER_POOL_SIZE || String(os.cpus().length), 10);
export const workerPool: WorkerPool | null = poolSize > 0 ? new WorkerPool(poolSize) : null;
