# Browser Automation MCP Tool Guide

Read this file first when using this MCP server. It is the canonical one-file index for available tools and usage rules. Do not scan the whole repository just to discover tools. Read implementation files only when you are editing or debugging the server itself.

## Strict Agent Rules

- Always check the available MCP tools before answering a task.
- NEVER attempt to read executable tools as resources (e.g., trying to read `mcp://browser-automation/browser_open`). Tools MUST be called via the tool execution interface, not the resource read interface. Tools are actions, not statically readable URIs.
- If a real MCP tool can perform the action, call the tool. Do not simulate opening a browser, clicking, typing, scrolling, uploading, or taking screenshots in text.
- If a URL is mentioned and the task is to open, test, inspect, debug, or interact with it, use `browser_open`.
- `open_browser` is a compatibility alias for prompts that use that name. New prompts should prefer `browser_open`.
- **ALWAYS** call `browser_sessions` before `browser_open` — reuse existing sessions instead of creating new ones.
- **ALWAYS** use `browser_scratchpad_write` for temporary files — NEVER create test files in the user's project.
- **ALWAYS** take screenshots after changes to verify them visually.
- If the client requires JSON-only tool routing, output only valid JSON in this shape:

```json
{
  "tool": "browser_open",
  "arguments": {
    "url": "https://example.com"
  }
}
```

- If the MCP client supports native tool calls, call the native tool directly instead of printing pretend JSON.
- If no relevant tool exists, answer normally and say what cannot be executed.

## First Call

To retrieve this guide from the running MCP server without reading random project files, simply execute the tool:
- **MCP tool:** `browser_tool_guide`

*(Note: Do not try to access this as an `mcp://` URI resource unless specifically instructed by your core system prompt. The safest method is always calling the tool).*

## Recommended Workflow

1. Call `browser_sessions` to check for existing sessions.
2. Open a URL with `browser_open` (reuses existing sessions automatically).
3. Inspect page state with `browser_analyze` or `browser_inspect`.
4. Act with `browser_click`, `browser_type`, `browser_fill_form`, `browser_select`, `browser_scroll`, `browser_hover`, `browser_wait`, or `browser_upload`.
5. Verify with `browser_screenshot`, `browser_errors`, `browser_test_page`, `browser_state`, or `browser_inspect`.
6. Close the session with `browser_close_session` when finished.

## Tool Catalog

### Guide

- `browser_tool_guide`: Return this canonical guide from the running MCP server.

### Session and Navigation

- `browser_open`: Open a URL. Creates a session if `sessionId` is omitted. Reuses existing sessions for the same domain. Optional args: `headless`, `persist`.
- `open_browser`: Compatibility alias for `browser_open`.
- `browser_close_session`: Close a session. Optional `cleanup` removes screenshots, downloads, and persisted user data for that session.
- `browser_sessions`: List active sessions. **Call this BEFORE browser_open.**
- `browser_reconnect`: Reconnect to a session that may have become unresponsive. Use this instead of closing + recreating.

### Interaction (Single)

- `browser_click`: Click by CSS `selector` or natural-language `query`. Use `settlePolicy` ('lazy', 'normal', 'strict') to control wait behavior.
- `browser_type`: Type text into one input. Automatic clearing is handled.
- `browser_hover`: Hover pointer over an element.
- `browser_scroll`: Scroll vertically by `pixels`.
- `browser_select`: Select an option in a `<select>` OR custom dropdown. Supports `value`, `label`, or `index`.
- `browser_press_key`: Press a keyboard key (e.g., 'Enter', 'Tab').
- `browser_upload`: Upload a file to a file input.
- `browser_wait`: Wait for a selector, query, text, or timeout.
- `browser_generate_pdf`: Generate a high-quality PDF of the current page.

### Batch Actions

- `browser_fill_form`: Fill multiple fields in one call. Use this for speed.
- `browser_flow`: Execute built-in templates: `login`, `signup`, or `formSubmission`.
- `browser_plan`: Generate and execute a multi-step plan for a goal.

### Inspection, Testing, and Design Extraction

- `browser_analyze`: Analyze DOM and interactive elements.
- `browser_inspect`: DOM analysis + errors + scratchpad.
- `browser_element_styles`: Extract computed CSS and layout for one element.
- `browser_page_style_map`: Sample visible DOM nodes with computed styles.
- `browser_test_page`: Health check for images, SEO, and errors.
- `browser_extract_blueprint`: High-fidelity JSON blueprint for UI cloning.
- `browser_get_palette`: Extract dominant color palette and fonts.
- `browser_errors`: Get collected console and network errors.
- `browser_screenshot`: Take a screenshot. Optional `fullPage` and `embedImage`.
- `browser_auto_explore`: Discover and visit navigation routes.

### Deep Clone (Pixel-Perfect)

- `browser_deep_clone`: Extract EVERYTHING for pixel-perfect cloning: all CSS rules (including :hover, :focus, :active, @keyframes), font-faces, asset URLs, DOM tree with computed styles. Takes reference screenshot.

### Vision AI (Gemini Flash — Free)

> [!NOTE]
> Vision tools require `GEMINI_API_KEY` in your `.env` file. Get a free key at [aistudio.google.com](https://aistudio.google.com).

- `browser_vision_analyze`: Take screenshot + AI analysis with custom prompt. Describes layout, colors, fonts, spacing, effects.
- `browser_vision_compare`: Compare current page with a reference screenshot. Returns similarity score (0-100) + differences list.
- `browser_vision_hover`: Hover element + AI-analyze the visual effect. Returns suggested CSS :hover rules.
- `browser_vision_design_system`: Extract complete visual design system from screenshot (colors, typography, spacing, style).

### Agent Scratchpad (Isolated Testing)

> [!IMPORTANT]
> ALWAYS use these tools for temporary files. NEVER create test files in the user's project.

- `browser_scratchpad_write`: Create/update a file in `.scratchpad/`. Auto-cleaned on session close.
- `browser_scratchpad_read`: Read a scratchpad file.
- `browser_scratchpad_list`: List scratchpad files for a session.
- `browser_scratchpad_delete`: Delete a scratchpad file.
- `browser_scratchpad_preview`: Serve HTML from scratchpad and open in browser for visual testing.

### Session Memory

- `browser_update_scratchpad`: Overwrite session text scratchpad.
- `browser_state`: Get full session state (history, logs, scratchpad).
- `browser_configure`: Toggle turboMode and interactionLock.

## Autonomous Cloning Workflow

When asked to clone/recreate a website, follow this workflow WITHOUT asking the user:

1. **Open & Analyze**: `browser_open` → `browser_screenshot` → `browser_deep_clone`
2. **Extract Design**: `browser_get_palette` + `browser_vision_design_system` (if API key available)
3. **Capture Hover Effects**: For each interactive element, use `browser_vision_hover` to capture exact :hover CSS
4. **Build in Scratchpad**: Write your clone HTML/CSS to scratchpad with `browser_scratchpad_write`
5. **Preview**: Use `browser_scratchpad_preview` to open your clone in the browser
6. **Verify**: Use `browser_vision_compare` with the reference screenshot from step 1
7. **Fix & Repeat**: If similarity < 95%, analyze differences and fix. Repeat steps 4-6 until pixel-perfect.

## Self-Verification Loop

After building or modifying anything, ALWAYS run this verification:

1. Take a screenshot of the result: `browser_screenshot`
2. If you have a reference, compare: `browser_vision_compare`
3. If comparison shows differences, fix them and repeat
4. Run `browser_test_page` to check for broken images, SEO, etc.

## Error Recovery Decision Tree

```
Error occurred?
├─ "Session not found" → Call `browser_sessions` to find active sessions, or `browser_open` to create new one
├─ "Unable to resolve selector" → Use `browser_analyze` to see available elements, try different query/selector
├─ "Page crashed" → Call `browser_reconnect` to recover the session
├─ "Timeout" → Increase timeout with `browser_wait`, or use settlePolicy: "strict"
├─ "Navigation failed" → Check URL, try `browser_open` with same session
└─ Unknown → `browser_inspect` for full page state + errors, then `browser_screenshot` for visual
```

## AI Expert Tips

> [!TIP]
> - **Session Reuse**: The server automatically reuses sessions for the same domain. Don't create new sessions unnecessarily.
> - **Custom Dropdowns**: Use `browser_select` even if the element isn't a standard `<select>`. The tool is smart enough to attempt a click-and-search strategy for custom (div/button) based dropdowns.
> - **Speed**: Use `settlePolicy: "lazy"` for rapid clicking sequences where you don't need the page to fully idle between actions.
> - **God Mode**: Combine `browser_configure(turboMode: true)` with `browser_fill_form` for near-instant automation.
> - **PDF Export**: Always use `browser_generate_pdf` for final verification of complex forms or invoices.
> - **Hover Effects**: Use `browser_vision_hover` instead of manually hovering + screenshotting. It captures before/after and suggests CSS.
> - **Pixel-Perfect**: Use `browser_deep_clone` → `browser_scratchpad_write` → `browser_scratchpad_preview` → `browser_vision_compare` for iterative cloning.

## Argument Patterns

- Most page actions require `sessionId`.
- Element actions accept either `selector` or `query`.
- Prefer `query` when you know the human-visible target (e.g., `"login button"`).
- Prefer `selector` when exact DOM targeting is required.

## Technical Calling Convention

If the AI client (e.g., Roo Code, Cliner, Cursor) uses a meta-tool wrapper like `use_mcp_tool` rather than a direct native function call, it MUST adhere to the following JSON structure:

```json
{
  "server_name": "browser-automation",
  "tool_name": "browser_open",
  "nativeArgs": {
    "url": "https://example.com"
  }
}
```

> [!WARNING]
> Failing to use the `nativeArgs` object key when calling via a wrapper will result in "Missing required argument" errors, as the server expects the tool arguments at the top level of the payload it receives from the client.
