# Browser Automation MCP Tool Guide

## TL;DR — 5-Step Quickstart

```
1. browser_sessions        → Check for existing sessions (ALWAYS first)
2. browser_open { url }    → Open URL / reuse session
3. browser_analyze { sid } → Find valid selectors & page structure
4. browser_click/type/fill → Interact with the page
5. browser_screenshot      → Verify result visually (embedImage: true)
```

> [!WARNING]
> **DO NOT** use `curl` or terminal HTTP commands. This is an **MCP STDIO** server.
> Use your native MCP tool calls. Port 1000 is the dashboard, NOT for tool execution.

> [!IMPORTANT]
> **DO NOT** create any files in the project root. Use `browser_scratchpad_write` for temp files.
> The server **auto-deletes** root clutter on startup.

---

## Strict Agent Rules

- Call `browser_sessions` before `browser_open` — **always reuse** existing sessions.
- Call `browser_analyze` before any click/type — **never guess selectors**.
- Use `browser_fill_form` for forms — **5x faster** than repeated `browser_type`.
- Use `browser_scratchpad_write` for temp files — **never** create files in the project.
- Set `embedImage: true`, `saveLocal: false` on screenshots.
- After every change, take a `browser_screenshot` to verify.
- NEVER access tools as MCP resource URIs (e.g., `mcp://browser-automation/browser_open` is INVALID).

### Calling Convention (Wrapper Clients)

If your client uses `use_mcp_tool`, pass args inside `nativeArgs`:
```json
{ "server_name": "browser-automation", "tool_name": "browser_open", "nativeArgs": { "url": "https://example.com" } }
```

### JSON-Only Tool Routing

If the client requires raw JSON output:
```json
{ "tool": "browser_open", "arguments": { "url": "https://example.com" } }
```

---

## Tool Catalog

### Guide

| Tool | Description |
|------|-------------|
| `browser_tool_guide` | Returns this guide from the running server |

### Session & Navigation

| Tool | Description |
|------|-------------|
| `browser_open` | Open a URL. Creates or reuses a session. Args: `url` (required), `sessionId`, `headless`, `persist` |
| `open_browser` | Alias for `browser_open` (backward compat) |
| `browser_close_session` | Close a session. `cleanup=true` removes all session data |
| `browser_sessions` | List active sessions. **Call this BEFORE browser_open** |
| `browser_reconnect` | Reconnect to an unresponsive session (better than close + recreate) |

### Single Interaction

| Tool | Description |
|------|-------------|
| `browser_click` | Click by `selector` (CSS) or `query` (natural language). `settlePolicy`: lazy/normal/strict |
| `browser_type` | Type text into one input. **Prefer browser_fill_form for multiple fields** |
| `browser_hover` | Hover over an element |
| `browser_scroll` | Scroll by `pixels` (+ down, - up). Default: 600 |
| `browser_select` | Select option in `<select>` or custom dropdown. Accepts `value`, `label`, or `index` |
| `browser_press_key` | Press keyboard key (Enter, Tab, Escape, Control+C, etc.) |
| `browser_upload` | Upload file to a file input. Args: `filePath` (absolute) |
| `browser_wait` | Wait for selector, query, text, or timeout |
| `browser_generate_pdf` | Export current page as PDF |

### Batch Actions (FAST)

| Tool | Description |
|------|-------------|
| `browser_fill_form` | Fill multiple fields in ONE call: `{ "Name": "John", "Email": "j@ex.com" }` |
| `browser_flow` | Execute template: `login`, `signup`, or `formSubmission` |
| `browser_plan` | Generate & execute a multi-step plan for a goal |

### Inspection & Testing

| Tool | Description |
|------|-------------|
| `browser_analyze` | Analyze DOM + interactive elements with optimized selectors |
| `browser_inspect` | Full inspection: DOM + errors + scratchpad |
| `browser_element_styles` | Computed CSS + layout for one element |
| `browser_page_style_map` | Sample visible DOM nodes with computed styles |
| `browser_test_page` | Health check: broken images, SEO, console errors |
| `browser_extract_blueprint` | High-fidelity JSON blueprint for UI cloning |
| `browser_get_palette` | Extract dominant colors and fonts |
| `browser_errors` | Get console and network errors |
| `browser_screenshot` | Screenshot. Default: `embedImage=true`, `saveLocal=false` |
| `browser_auto_explore` | Discover and visit navigation routes |

### Deep Clone (Pixel-Perfect)

| Tool | Description |
|------|-------------|
| `browser_deep_clone` | Extract ALL CSS, fonts, assets, DOM tree for pixel-perfect cloning |

### Vision AI (Gemini Flash — Free)

> Requires `GEMINI_API_KEY` in `.env`. Free at [aistudio.google.com](https://aistudio.google.com).

| Tool | Description |
|------|-------------|
| `browser_vision_analyze` | Screenshot + AI analysis with custom prompt |
| `browser_vision_compare` | Compare page with reference. Returns similarity score (0-100) |
| `browser_vision_hover` | Hover + AI-analyze visual effect. Returns suggested CSS :hover |
| `browser_vision_design_system` | Extract complete design system from screenshot |

### Figma Integration

> Requires `FIGMA_API_TOKEN` in `.env`.

| Tool | Description |
|------|-------------|
| `browser_figma_file` | Fetch Figma file metadata + document tree |
| `browser_figma_nodes` | Fetch specific node(s) by ID |
| `browser_figma_design_context` | AI-ready summary of Figma file for implementation |
| `browser_figma_to_clone_plan` | Auto-generate implementation plan from Figma |

### Scratchpad (Isolated Testing)

> **ALWAYS** use these for temp files. NEVER create files in the project root.

| Tool | Description |
|------|-------------|
| `browser_scratchpad_write` | Create/update file in `.scratchpad/`. Auto-cleaned on session close |
| `browser_scratchpad_read` | Read a scratchpad file |
| `browser_scratchpad_list` | List scratchpad files |
| `browser_scratchpad_delete` | Delete a scratchpad file |
| `browser_scratchpad_preview` | Serve HTML from scratchpad in browser |

### Session Memory & Config

| Tool | Description |
|------|-------------|
| `browser_update_scratchpad` | Overwrite session text scratchpad |
| `browser_state` | Get full session state (history, logs, scratchpad) |
| `browser_configure` | Toggle `turboMode` and `interactionLock` |

### Project Sync & Root Safety

| Tool | Description |
|------|-------------|
| `browser_project_sync_status` | Check managed dirs health + detect root clutter |
| `browser_project_sync_fix` | Auto-fix: create dirs + clean root clutter |

### REST Bridge (Non-MCP AI)

| Endpoint | Description |
|----------|-------------|
| `POST /api/bridge/call` | Execute any tool: `{ "tool": "browser_sessions", "arguments": {} }` |
| `GET /api/bridge/prompt` | Returns quick instructions for bridge usage |

---

## Workflows

### Autonomous Cloning

1. `browser_open` → `browser_screenshot` → `browser_deep_clone`
2. `browser_get_palette` + `browser_vision_design_system`
3. For each interactive element: `browser_vision_hover`
4. Build in scratchpad: `browser_scratchpad_write`
5. Preview: `browser_scratchpad_preview`
6. Verify: `browser_vision_compare` (target: >95% similarity)
7. Fix & repeat until pixel-perfect

### Error Recovery

| Error | Solution |
|-------|----------|
| Session not found | `browser_sessions` → find or `browser_open` to create |
| Selector not found | `browser_analyze` → find valid selectors |
| Page crashed | `browser_reconnect` |
| Timeout | `browser_wait` with longer timeout, or `settlePolicy: "strict"` |
| Navigation failed | Check URL, retry `browser_open` |
| Unknown | `browser_inspect` + `browser_screenshot` |

---

## Argument Patterns

- Most tools require `sessionId`
- Element tools accept `selector` (CSS) or `query` (natural language)
- Prefer `query` for human-visible targets: `"login button"`
- Prefer `selector` for exact DOM targeting: `"#submit-btn"`
