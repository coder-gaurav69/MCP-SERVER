# Browser Automation MCP Server

Production-ready Node.js + Playwright MCP server for AI-driven browser automation.

> [!TIP]
> **AI Agents (Cursor, Copilot, Roo Code, Antigravity)**: Read [MCP_TOOL_GUIDE.md](./MCP_TOOL_GUIDE.md) for the full tool catalog. Use native MCP tool calls — **never** use `curl` or terminal HTTP.

> [!IMPORTANT]
> **Non-MCP AI (ChatGPT, Claude web, etc.)**: See [PROMPT_FOR_ANY_AI.md](./PROMPT_FOR_ANY_AI.md) for copy-paste REST API instructions.

---

## Requirements

- Node.js 18.18+
- npm

## Install

```bash
npm install
```

## Run

```bash
# MCP STDIO mode (for AI agents — Cursor, Roo Code, etc.)
node mcp-server.js

# Or via npm
npm run mcp
```

The server starts in **dual mode**:
- **STDIO**: JSON-RPC over stdin/stdout for MCP clients
- **HTTP Dashboard**: `http://localhost:1000` for monitoring & REST API

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `1000` | Dashboard & REST API port |
| `HEADLESS` | `false` | Run browser in headless mode |
| `DEFAULT_TIMEOUT_MS` | `10000` | Default timeout for actions |
| `MAX_RETRIES` | `3` | Max retries for failed actions |
| `SCREENSHOT_DIR` | `.mcp_data/screenshots` | Screenshot storage |
| `BROWSER_CHANNEL` | *(empty)* | Use system Chrome: `chrome` or `msedge` |
| `STEALTH_MODE` | `true` | Anti-detection measures |
| `TURBO_MODE` | `false` | Skip animations for speed |
| `INTERACTION_LOCK` | `true` | Block manual clicks during automation |
| `SESSION_REUSE` | `true` | Reuse sessions for same domain |
| `GEMINI_API_KEY` | *(empty)* | Free Vision AI — get at [aistudio.google.com](https://aistudio.google.com) |
| `FIGMA_API_TOKEN` | *(empty)* | Figma integration |
| `SCRATCHPAD_DIR` | `.mcp_data/scratchpad` | Isolated temp file directory |

---

## For Developers

### Response Format

All REST endpoints return:
```json
{
  "status": "success | error",
  "action": "toolName",
  "data": {},
  "error": ""
}
```

### Quick REST API Test

```bash
# Health check
curl http://localhost:1000/health

# Open a URL
curl -X POST http://localhost:1000/api/bridge/call -H "Content-Type: application/json" -d "{\"tool\": \"browser_open\", \"arguments\": {\"url\": \"https://example.com\"}}"

# List sessions
curl http://localhost:1000/api/bridge/call -X POST -H "Content-Type: application/json" -d "{\"tool\": \"browser_sessions\", \"arguments\": {}}"
```

### API Discovery

| Endpoint | Description |
|----------|-------------|
| `GET /api/tools` | List all tool names |
| `GET /api/tools/:name/schema` | Get tool schema (OpenAI format) |
| `GET /api/tools/definitions/openai` | All tools in OpenAI function format |
| `GET /api/tools/definitions/mcp` | All tools in MCP format |
| `POST /api/bridge/call` | Execute any tool via REST |
| `GET /mcp/sse` | MCP over SSE transport |

### REST Endpoints (Legacy)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/open` | Open URL |
| `POST` | `/click` | Click element |
| `POST` | `/type` | Type text |
| `POST` | `/scroll` | Scroll page |
| `POST` | `/hover` | Hover element |
| `POST` | `/select` | Select option |
| `POST` | `/wait` | Wait for element |
| `POST` | `/fill_form` | Fill form fields |
| `POST` | `/plan` | Execute goal plan |
| `POST` | `/flow/:template` | Execute flow template |
| `GET` | `/screenshot` | Take screenshot |
| `GET` | `/analyze` | Analyze DOM |
| `GET` | `/inspect` | Full page inspection |
| `GET` | `/errors` | Console/network errors |
| `GET` | `/sessions` | List sessions |
| `DELETE` | `/session/:id` | Close session |
| `GET` | `/health` | Health check |
| `GET` | `/agent/events` | Agent activity SSE stream |
| `GET` | `/agent/state` | Agent activity state |

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on:
- Dual-transport model (STDIO + HTTP)
- Interaction Lock ("Iron Curtain")
- Smart Settle Logic
- Session Persistence
- Vision AI integration
- Dynamic Selector Resolution

---

## Project Structure

```
MCP-SERVER/
├── mcp-server.js          # Entry point (imports src/mcpServer.js)
├── src/
│   ├── mcpServer.js        # MCP server, tool registration, STDIO transport
│   ├── app.js              # Express HTTP app, REST API, SSE
│   ├── config.js           # Environment config loader
│   ├── routes/
│   │   └── browserRoutes.js # Legacy REST endpoints
│   ├── services/
│   │   ├── browserService.js       # Core Playwright automation engine
│   │   ├── visionService.js        # Gemini Vision AI integration
│   │   ├── figmaService.js         # Figma API integration
│   │   ├── scratchpadService.js    # Isolated temp file management
│   │   ├── projectSyncService.js   # Root safety & auto-cleanup
│   │   └── agentActivityService.js # Agent activity tracking & SSE
│   ├── utils/
│   │   └── response.js     # Standard response formatter
│   └── static/
│       ├── dashboard.html  # Management dashboard UI
│       └── style.css       # Dashboard styles
├── .mcp_data/              # Managed data directory (gitignored)
│   ├── screenshots/
│   ├── downloads/
│   ├── scratchpad/
│   └── user_data/
├── .clinerules             # AI rules for Cline/Roo Code
├── .cursorrules            # AI rules for Cursor
├── ARCHITECTURE.md         # Technical architecture docs
├── MCP_TOOL_GUIDE.md       # Canonical tool catalog for AI agents
└── PROMPT_FOR_ANY_AI.md    # REST API guide for non-MCP AIs
```
