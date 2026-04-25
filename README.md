# Browser Automation MCP Server

Production-ready Node.js + Playwright MCP server for AI-driven browser automation.

> [!TIP]
> **AI Agents (Cursor, Copilot, Roo Code, Antigravity)**: Use native MCP tool calls for best results. Read the [Rules](#strict-agent-rules) below before starting.

> [!IMPORTANT]
> **Non-MCP AI (ChatGPT, Claude web, etc.)**: See the [Connection Prompt](#how-to-connect-any-ai) section to enable this server for your LLM.

---

## Dual-Transport Model

### 1. Primary: STDIO (Standard I/O)
- **Used by**: AI Agents (Cursor, Roo Code, Copilot, etc.)
- **Protocol**: JSON-RPC over Stdin/Stdout.
- **Tools**: All `browser_*` tools.

### 2. Secondary: HTTP (Dashboard & SSE)
- **Port**: `1000` (Default)
- **Used by**: Developers for debugging via the local dashboard (`http://localhost:1000`).
- **Features**: Visual logs, session monitoring, direct control, screenshot serving.

---

## Quickstart

```bash
# Install
npm install

# Run (dual-mode: STDIO + HTTP)
npm run mcp
```

### CLI Helper (Fastest for Terminal)
If you have Node.js, use the built-in helper to avoid `curl` quoting issues:
```bash
node mcp.js browser_open --url https://google.com
node mcp.js browser_sessions
```

---

## Strict Agent Rules

- **Always reuse sessions**: Call `browser_sessions` before `browser_open`.
- **Never guess selectors**: Call `browser_analyze` before any click/type to find valid targets.
- **Prefer Batching**: Use `browser_fill_form` for multiple fields—it's 5x faster than repeated typing.
- **Stay Clean**: Use `browser_scratchpad_write` with the right category (`scripts`, `tests`, `pages`, `artifacts`, `notes`, `tmp`) for generated files. **Never** create files in the project root.
- **Verify Visually**: Set `embedImage: true` on screenshots and verify every action.

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `1000` | Dashboard & REST API port |
| `HEADLESS` | `false` | Run browser in headless mode |
| `DEFAULT_TIMEOUT_MS` | `10000` | Default timeout for actions |
| `SCREENSHOT_DIR` | `src/.ai_outputs/screenshots` | Screenshot storage |
| `GEMINI_API_KEY` | *(empty)* | Vision AI — get at [aistudio.google.com](https://aistudio.google.com) |
| `FIGMA_API_TOKEN` | *(empty)* | Optional Figma integration |
| `SCRATCHPAD_DIR` | `src/.ai_outputs/ai_workspace` | Isolated AI workspace for generated scripts, tests, pages, and drafts |

---

## Key Features

- **Interaction Lock ("Iron Curtain")**: Blocks manual input during automation to prevent state corruption.
- **Smart Settle Logic**: Intelligent waiting for network and UI stability (lazy/normal/strict).
- **Session Persistence**: Domain-based session reuse and cookies/localStorage persistence.
- **Vision AI (Gemini)**: Visual debugging, design system extraction, and UI similarity scoring.
- **Agent Scratchpad**: Isolated temp directory that never pollutes your main project.

---

## How to Connect ANY AI

If your AI agent doesn't support MCP natively (e.g., ChatGPT web), copy this prompt:

> You have access to a local Browser Automation Server at **http://localhost:1000**.
> It controls a real Chrome browser. Use these endpoints:
> - **Discovery**: `GET /api/tools/browser_sessions`
> - **Navigation**: `GET /api/tools/browser_open?url=https://example.com`
> - **Interaction**: `POST /api/tools/browser_click`, `POST /api/tools/browser_fill_form`
> - **Schemas**: `GET /api/tools/definitions/mcp`
>
> Workflow: 1. `browser_sessions` → 2. `browser_open` → 3. `browser_analyze` → 4. Interaction → 5. `browser_screenshot`.

---

## Project Structure

```
MCP-SERVER/
├── src/                    # Core source code
│   ├── mcpServer.js        # MCP server & STDIO transport
│   ├── app.js              # Express HTTP app & REST API
│   ├── services/           # Automation, Vision, Sync services
│   └── static/             # Dashboard UI
├── .mcp_data/              # Data storage (gitignored)
├── mcp.js                  # CLI bridge helper
├── package.json            # Scripts & dependencies
└── README.md               # This guide
```
