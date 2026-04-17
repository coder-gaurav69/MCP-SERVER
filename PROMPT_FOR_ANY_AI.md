# How to Connect ANY AI to This Browser Server

This guide is for AI agents that **don't support MCP natively** (e.g., ChatGPT, Claude web, generic LLMs). If your AI already has MCP support (Cursor, Roo Code, Copilot), just use the native tools directly — you don't need this file.

---

## Quick Setup

This server runs at `http://localhost:1000` and provides a REST API bridge.

### Copy-Paste This Prompt Into Your AI:

> You have access to a local Browser Automation Server at **http://localhost:1000**.
> It controls a real Chrome browser on the user's computer.
>
> **To use any tool, make a POST request:**
> ```
> POST http://localhost:1000/api/bridge/call
> Content-Type: application/json
>
> { "tool": "TOOL_NAME", "arguments": { ... } }
> ```
>
> **IMPORTANT WORKFLOW — Always follow this order:**
>
> **Step 1: Check for existing sessions**
> ```json
> { "tool": "browser_sessions", "arguments": {} }
> ```
>
> **Step 2: Open a URL (or reuse an existing session)**
> ```json
> { "tool": "browser_open", "arguments": { "url": "https://example.com" } }
> ```
> Save the `sessionId` from the response — you need it for every other call.
>
> **Step 3: Analyze the page (find selectors)**
> ```json
> { "tool": "browser_analyze", "arguments": { "sessionId": "SESSION_ID" } }
> ```
>
> **Step 4: Interact (click, type, fill forms)**
> ```json
> { "tool": "browser_click", "arguments": { "sessionId": "SESSION_ID", "query": "Login button" } }
> ```
> ```json
> { "tool": "browser_fill_form", "arguments": { "sessionId": "SESSION_ID", "fields": { "Email": "user@example.com", "Password": "secret123" } } }
> ```
>
> **Step 5: Take a screenshot to verify**
> ```json
> { "tool": "browser_screenshot", "arguments": { "sessionId": "SESSION_ID" } }
> ```
>
> **Available tools:** browser_open, browser_sessions, browser_click, browser_type, browser_fill_form, browser_screenshot, browser_analyze, browser_scroll, browser_hover, browser_select, browser_wait, browser_press_key, browser_close_session, browser_errors
>
> **Full tool list with schemas:** GET http://localhost:1000/api/tools/definitions/openai

---

## Why Use This?

- **Universal**: Works with any AI that can make HTTP requests
- **Visual**: See exactly what the AI is doing in a real Chrome window
- **No MCP Required**: Pure REST API — no special protocol setup needed
- **Session-Based**: Multiple AI agents can share browser sessions
