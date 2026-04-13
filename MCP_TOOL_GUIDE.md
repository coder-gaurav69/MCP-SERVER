# Browser Automation MCP Tool Guide

Read this file first when using this MCP server. It is the canonical one-file index for available tools and usage rules. Do not scan the whole repository just to discover tools. Read implementation files only when you are editing or debugging the server itself.

## Strict Agent Rules

- Always check the available MCP tools before answering a task.
- If a real MCP tool can perform the action, call the tool. Do not simulate opening a browser, clicking, typing, scrolling, uploading, or taking screenshots in text.
- If a URL is mentioned and the task is to open, test, inspect, debug, or interact with it, use `browser_open`.
- `open_browser` is a compatibility alias for prompts that use that name. New prompts should prefer `browser_open`.
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

- MCP resource: `mcp://browser-automation/tool-guide`
- MCP tool: `browser_tool_guide`

Use either of these to retrieve this guide from the running MCP server without reading random project files.

## Recommended Workflow

1. Open a URL with `browser_open`.
2. Inspect page state with `browser_analyze` or `browser_inspect`.
3. Act with `browser_click`, `browser_type`, `browser_fill_form`, `browser_select`, `browser_scroll`, `browser_hover`, `browser_wait`, or `browser_upload`.
4. Verify with `browser_screenshot`, `browser_errors`, `browser_test_page`, `browser_state`, or `browser_inspect`.
5. Close the session with `browser_close_session` when finished.

## Tool Catalog

### Guide

- `browser_tool_guide`: Return this canonical guide from the running MCP server.

### Session and Navigation

- `browser_open`: Open a URL. Creates a session if `sessionId` is omitted. Optional args: `headless`, `persist`.
- `open_browser`: Compatibility alias for `browser_open`.
- `browser_close_session`: Close a session. Optional `cleanup` removes screenshots, downloads, and persisted user data for that session.
- `browser_sessions`: List active sessions.

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

## AI Expert Tips

> [!TIP]
> - **Custom Dropdowns**: Use `browser_select` even if the element isn't a standard `<select>`. The tool is smart enough to attempt a click-and-search strategy for custom (div/button) based dropdowns.
> - **Speed**: Use `settlePolicy: "lazy"` for rapid clicking sequences where you don't need the page to fully idle between actions.
> - **God Mode**: Combine `browser_configure(turboMode: true)` with `browser_fill_form` for near-instant automation that bypasses slow UI animations.
> - **PDF Export**: Always use `browser_generate_pdf` for final verification of complex forms or invoices rather than just screenshots.

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

