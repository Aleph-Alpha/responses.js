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
const port = parseInt(String(process.env.PORT || 3000), 10);
const highWaterMark = parseInt(process.env.STREAM_HIGH_WATER_MARK || "65536", 10);
const backlog = parseInt(process.env.TCP_BACKLOG || "5000", 10);

// Start server with configurable highWaterMark for SSE streaming backpressure
// and configurable TCP backlog (SO_MAXCONN / listen queue depth)
const server = createServer({ highWaterMark }, app);
server.listen(port, "0.0.0.0", backlog, () => {
	logger.info({ port, highWaterMark, backlog, pid: process.pid }, "Server started");
	logger.info({ url: `http://localhost:${port}` }, "Server is running");
});

// Graceful shutdown logging
process.on("SIGINT", () => {
	logger.info({ pid: process.pid }, "Server shutting down (SIGINT)");
	server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
	logger.info({ pid: process.pid }, "Server shutting down (SIGTERM)");
	server.close(() => process.exit(0));
});

export default app;
