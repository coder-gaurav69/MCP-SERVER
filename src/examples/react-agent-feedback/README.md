# React Agent Feedback Integration

This folder contains a minimal integration for real-time MCP activity feedback in React.

## Files

- `AgentActivityProvider.jsx`: Global state (`isAgentWorking`, message, lifecycle setters)
- `useMcpAgentActivity.js`: SSE lifecycle hook + wrapped MCP call helper
- `AgentWorkingOverlay.jsx`: Top indicator + subtle overlay + interaction lock wrapper
- `ExamplePage.jsx`: Example page/form usage

## Server endpoints used

- `GET /agent/events` (SSE stream for lifecycle updates)
- `GET /agent/state` (current activity snapshot)

## Behavior

- Start work: `isAgentWorking = true`, message updates from MCP action name.
- While running: lock UI interaction with Tailwind classes (`pointer-events-none opacity-50 cursor-not-allowed`).
- End work: `isAgentWorking = false`, lock removed automatically.
