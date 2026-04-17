# How to connect ANY AI to this Browser Server

To give an AI agent (like ChatGPT, Claude, or another Cursor window) full control over your browser using this server, copy and paste the following prompt into that AI's chat.

---

### Copy this Prompt:

> I have a local Browser Automation Server running at **http://localhost:1000**.
> This server provides full control over a Chrome browser (Click, Type, Scroll, Screenshot, PDF, UI Analysis).
>
> Please use the following tool definitions to interact with it via its REST API. 
> To execute a tool, make a **POST request** to `http://localhost:1000/api/tools/{tool_name}` with the arguments in the JSON body.
>
> **CRITICAL:** Always check `browser_sessions` first. If no session exists, call `browser_open` with a URL to create one. Use the returned `sessionId` for all subsequent calls.
>
> **Tool Definitions (OpenAI Format):**
> [Visit http://localhost:1000/api/tools/definitions/openai to get the latest JSON and paste it here]

---

### Why use this?
- **Universal**: Works with any AI that can make web requests.
- **Visual**: You can see exactly what the AI is doing on your screen.
- **Reliable**: No complex MCP installation or VS Code setup required.
- **Cross-Platform**: Connect a Claude instance in your browser to your local VS Code terminal's browser server.
