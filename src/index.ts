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
import { config } from "./lib/config.js";

const app = createApp();

const { port, host, streamHighWaterMark, tcpBacklog, shutdownTimeoutMs } = config;

// Start server with configurable highWaterMark for SSE streaming backpressure
// and configurable TCP backlog (SO_MAXCONN / listen queue depth)
const server = createServer({ highWaterMark: streamHighWaterMark }, app);
server.listen(port, host, tcpBacklog, () => {
	logger.info({ port, highWaterMark: streamHighWaterMark, backlog: tcpBacklog, pid: process.pid }, "Server started");
	logger.info({ url: `http://localhost:${port}` }, "Server is running");
});

function shutdown(signal: string): void {
	logger.info({ pid: process.pid, signal, shutdownTimeoutMs }, `Server shutting down (${signal})`);

	// Stop accepting new connections and wait for in-flight requests
	server.close(() => {
		logger.info({ pid: process.pid }, "All connections closed, exiting");
		process.exit(0);
	});

	// Close idle keep-alive connections immediately
	server.closeIdleConnections();

	// Force-close all remaining connections after grace period
	setTimeout(() => {
		logger.warn({ pid: process.pid, shutdownTimeoutMs }, "Shutdown timeout reached, forcing close");
		server.closeAllConnections();
	}, shutdownTimeoutMs).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
