# MCP Browser Automation Architecture

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
- **Features**: Visual logs, session monitoring, and direct control.
- **WARNING**: Do NOT attempt to use `curl` on the HTTP port to execute MCP tools from an AI agent. The AI should call tools natively through its environment.

## Key Features

### Interaction Lock ("Iron Curtain")
When an AI agent is performing a sequence of actions, the browser window is **locked** via an injected CSS/JS overlay. This prevents the user from accidentally clicking or typing during the automation, which would cause selector failures and state corruption.

### Smart Settle Logic
Every action (click, type, select) is followed by a `waitForSettle` call.
- **normal**: Waits for network idle and internal stability.
- **lazy**: Minimal wait, used for high-speed sequences.
- **strict**: Extensive wait for heavy page loads.

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
