# MCP Browser Automation Architecture (v3.0)

This server is designed to provide high-performance, AI-driven browser automation via the **Model Context Protocol (MCP)**. It uses **Playwright** as the underlying engine.

## Dual-Transport Model

### 1. Primary: STDIO (Standard I/O)
- **Used by**: AI Agents (Cursor, Roo Code, Copilot, etc.)
- **Protocol**: JSON-RPC over Stdin/Stdout.
- **Tools**: All `browser_*` tools.
- **Note**: This is the only way for an AI to interact with the browser statefully.

### 2. Secondary: HTTP (Dashboard & SSE)
- **Port**: `1000` (Default)
- **Used by**: Developers for debugging via the local dashboard.
- **Features**: Visual logs, session monitoring, direct control, screenshot serving.
- **WARNING**: Do NOT attempt to use `curl` on the HTTP port to execute MCP tools from an AI agent. The AI should call tools natively through its environment.

## Key Features

### Interaction Lock ("Iron Curtain")
When an AI agent is performing a sequence of actions, the browser window is **locked** via an injected CSS/JS overlay. This prevents the user from accidentally clicking or typing during the automation, which would cause selector failures and state corruption.

**v3.0 Improvements:**
- All tool methods use `withAgentLock()` for consistent try/finally lock management
- Server-side `_agentActive` tracking prevents lock release failures
- `framenavigated` listener re-injects the overlay on SPA navigations

### Smart Settle Logic
Every action (click, type, select) is followed by a `waitForSettle` call.
- **normal**: Waits for network idle and internal stability.
- **lazy**: Minimal wait, used for high-speed sequences.
- **strict**: Extensive wait for heavy page loads.

### Session Persistence
- Sessions are automatically reused for the same domain (configurable via `SESSION_REUSE`)
- `browser_reconnect` recovers unresponsive sessions without recreating them
- Domain-based session matching prevents duplicate sessions

### Vision AI (Gemini Flash)
- Screenshot → AI analysis for visual understanding
- Before/after hover comparison for CSS effect extraction
- Clone vs. original comparison for pixel-accuracy scoring
- Design system extraction from screenshots

### Agent Scratchpad
- Isolated `.scratchpad/` directory for all temporary agent files
- Never pollutes the user's project
- Auto-cleaned on session close
- HTML preview via local HTTP server

### Project Sync & Root Safety
- Startup enforces managed directories under `.mcp_data/` for artifacts and persistence.
- Built-in sync tools can detect and clean known AI-generated temporary clutter in project root.
- This keeps browser artifacts, scratch files, and persistent session data centralized and prevents root pollution.

### Dynamic Selector Resolution
The server uses multiple strategies to find elements:
1.  **Direct CSS**: Fastest, exact target.
2.  **Text Match**: Human-like finding (e.g., `text="Login"`).
3.  **Natural Language (AI)**: If text/css fails, it uses a lightweight model to hypothesize the best target.

### Turbo Mode
When enabled:
- UI animations are disabled.
- Mouse movements are instant (not curved).
- Page settling is minimal.

## Session Management
- Sessions are keyed by a `sessionId`.
- Each session has its own **Scratchpad** (a text memory area where the agent can store notes about the current page).
- **Persistence**: Sessions can persist cookies and local storage if `persist: true` is passed to `browser_open`.
- **Domain Reuse**: If `SESSION_REUSE=true`, opening the same domain reuses the existing session.

## Screenshot API
External consumers can access screenshots via HTTP:
- `GET /screenshot/image?sessionId=...` — Raw PNG image
- `GET /screenshot/latest/:sessionId` — Most recent screenshot
- `GET /screenshots/:sessionId` — List all with download URLs
- `GET /screenshot/file/:sessionId/:filename` — Specific file
