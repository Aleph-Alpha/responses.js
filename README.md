# responses.js

A lightweight Express.js server that implements a translation layer between the two main LLM APIs currently available, Responses API and Chat Completions. Works with any Chat Completion API, local or remotely hosted.

## 🎮 Live Demo

[**Try responses.js right now, no installation needed!**](https://huggingface.co/spaces/Wauplin/responses.js)

## ✨ Features

- **ResponsesAPI**: Partial implementation of [OpenAI's Responses API](https://platform.openai.com/docs/api-reference/responses), on top of Chat Completion API
- **Provider Agnostic**: Works with any Chat Completion API (local or remote)
- **Streaming Support**: Support for streamed responses
- **Structured Output**: Support for structured data responses (e.g. jsonschema)
- **Function Calling**: Tool and function calling capabilities
- **Multi-modal Input**: Text and image input support
- **Remote MCP**: Execute MCP tool calls remotely
- **Demo UI**: Interactive web interface for testing

Not implemented: remote function calling, file upload, stateful API, etc.

## 🚀 Quick Start

### Prerequisites

- Node.js (v18 or higher)
- pnpm (recommended) or npm
- an Hugging Face token with inference permissions. Create one from your [user settings](https://huggingface.co/settings/tokens).

### Installation & Setup

```bash
# Clone the repository
git clone https://github.com/huggingface/responses.js.git
cd responses.js

# Install dependencies
pnpm install

# Start the development server
pnpm dev
```

The server will be available at `http://localhost:3000`.

### OpenTelemetry (GenAI) tracing

`responses.js` emits OpenTelemetry spans for response execution (`gen_ai.operation.name=chat`) and tool execution (`gen_ai.operation.name=execute_tool`).

- Parent trace context is extracted from incoming propagation headers (`traceparent`/`tracestate`), so spans attach to your upstream instrumentation.
- Tool metadata is always traced (`gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`, `mcp.server_label`).
- Tool arguments/results are optional and controlled by:

```bash
OTEL_GENAI_CAPTURE_TOOL_CONTENT=true
```

Set it to `false` (or unset) to avoid collecting tool arguments/results in span attributes.

#### Disabling OpenTelemetry

If no OTel collector is running, you can suppress tracing, metrics, and diagnostic noise by setting:

```bash
OTEL_DISABLED=true   # or "1"
```

When set, `trace.disable()`, `metrics.disable()`, and a no-op diagnostic logger are applied at startup.

### Running Examples

Explore the various capabilities with our example scripts located in the [./examples](./examples) folder:

```bash
# Basic text input
pnpm run example text

# Multi-turn conversations
pnpm run example multi_turn

# Text + image input
pnpm run example image

# Streaming responses
pnpm run example streaming

# Structured output
pnpm run example structured_output
pnpm run example structured_output_streaming

# Function calling
pnpm run example function
pnpm run example function_streaming
```

## 🧪 Testing

### Important Notes

- Server must be running (`pnpm dev`) on `http://localhost:3000`
- `API_KEY` environment variable set with your LLM provider's API key
- Tests use real inference providers and may incur costs
- Tests are not run in CI due to billing requirements

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific test patterns
pnpm test --grep "streaming"
pnpm test --grep "function"
pnpm test --grep "structured"
```

### Interactive Demo UI

Experience the API through our interactive web interface, adapted from the [openai-responses-starter-app](https://github.com/openai/openai-responses-starter-app).

[![Demo Video](https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/responses.js/demo_mini.png)](https://youtu.be/F-tAUnW-nd0)


#### Setup

1. Create a configuration file:

```bash
# Create demo/.env
cat > demo/.env << EOF
MODEL="moonshotai/Kimi-K2-Instruct:groq"
OPENAI_BASE_URL=http://localhost:3000/v1
OPENAI_API_KEY=${HF_TOKEN:-<your-huggingface-token>}
EOF
```

2. Install demo dependencies:

```bash
pnpm demo:install
```

3. Launch the demo:

```bash
pnpm demo:dev
```

The demo will be available at `http://localhost:3001`.

## Debugging with VS Code

1. Start the dev server with the Node.js inspector enabled:

```bash
pnpm dev:debug
```

2. In VS Code, open the **Run and‚ Debug** panel (`Cmd+Shift+D`) and select **Attach to Process**, then press **F5**.

Breakpoints set in any `.ts` file under `src/` will be hit. The `restart: true` option in the launch config means the debugger will automatically re-attach if the process restarts.

## Running with Docker

You can run the server in a production-ready container using Docker.

### Build the Docker image

```bash
docker build -t responses.js .
```

### Run the server

```bash
docker run -p 3000:3000 responses.js
```

The server will be available at `http://localhost:3000`.

## 📁 Project Structure

```
responses.js/
├── demo/             # Interactive chat UI demo
├── examples/         # Example scripts using openai-node client
├── src/
│   ├── index.ts      # Application entry point
│   ├── server.ts     # Express app configuration and route definitions
│   ├── routes/       # API route implementations
│   ├── middleware/   # Middleware (validation, logging, etc.)
│   └── schemas/      # Zod validation schemas
├── scripts/          # Utility and build scripts
├── package.json      # Package configuration and dependencies
└── README.md         # This file
```

## 🛣️ Done / TODOs

> **Note**: This project is in active development. The roadmap below represents our current priorities and may evolve. Do not take anything for granted.

- [x] OpenAI types integration for consistent output
- [x] Streaming mode support
- [x] Structured output capabilities
- [x] Function calling implementation
- [x] Repository migration to dedicated responses.js repo
- [x] Basic development tooling setup
- [x] Demo application with comprehensive instructions
- [x] Multi-turn conversation fixes for text messages + tool calls
- [x] Correctly return "usage" field
- [x] MCP support (non-streaming)
- [x] MCP support (streaming)
- [ ] Tools execution (web search, file search, image generation, code interpreter)
- [ ] Background mode support
- [ ] Additional API routes (GET, DELETE, CANCEL, LIST responses)
- [ ] Reasoning capabilities

## 🤝 Contributing

We welcome contributions! Please feel free to submit issues, feature requests, or pull requests.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Based on OpenAI's [Responses API specification](https://platform.openai.com/docs/api-reference/responses)
- Built on top of [OpenAI's nodejs client](https://github.com/openai/openai-node)
- Demo UI adapted from [openai-responses-starter-app](https://github.com/openai/openai-responses-starter-app)
