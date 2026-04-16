import { disableOtelIfRequested } from "./lib/otel.js";
disableOtelIfRequested();

// Note on ESM import hoisting: although static imports below are hoisted before
// disableOtelIfRequested() runs, this is safe because the OTel API uses lazy
// resolution patterns. trace.getTracer() returns a ProxyTracer that resolves its
// delegate on each startSpan() call, and metrics.getMeter() returns a NoopMeter
// until an SDK is registered. So disabling OTel here takes effect before any
// actual spans or metrics are emitted.
import { createServer } from "node:http";
import { createApp } from "./server.js";
import { logger } from "./lib/logger.js";

const app = createApp();

function parseIntEnv(name: string, fallback: number): number {
	const value = parseInt(process.env[name] || String(fallback), 10);
	if (!Number.isFinite(value)) {
		throw new Error(`Invalid value for ${name}: must be a finite number`);
	}
	return value;
}

const port = parseIntEnv("PORT", 3000);
const host = process.env.HOST || "0.0.0.0";
const highWaterMark = parseIntEnv("STREAM_HIGH_WATER_MARK", 65536);
const backlog = parseIntEnv("TCP_BACKLOG", 5000);

// Start server with configurable highWaterMark for SSE streaming backpressure
// and configurable TCP backlog (SO_MAXCONN / listen queue depth)
const server = createServer({ highWaterMark }, app);
server.listen(port, host, backlog, () => {
	logger.info({ port, highWaterMark, backlog, pid: process.pid }, "Server started");
	logger.info({ url: `http://localhost:${port}` }, "Server is running");
});

// Graceful shutdown with timeout for long-lived SSE connections
const shutdownTimeout = parseIntEnv("SHUTDOWN_TIMEOUT_MS", 10000);

function shutdown(signal: string) {
	logger.info({ pid: process.pid, signal, shutdownTimeout }, `Server shutting down (${signal})`);

	// Stop accepting new connections and wait for in-flight requests
	server.close(() => {
		logger.info({ pid: process.pid }, "All connections closed, exiting");
		process.exit(0);
	});

	// Close idle keep-alive connections immediately
	server.closeIdleConnections();

	// Force-close all remaining connections after grace period
	setTimeout(() => {
		logger.warn({ pid: process.pid, shutdownTimeout }, "Shutdown timeout reached, forcing close");
		server.closeAllConnections();
	}, shutdownTimeout).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
