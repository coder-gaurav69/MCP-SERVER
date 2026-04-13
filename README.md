# Browser Automation MCP Server

Production-ready Node.js + Express + Playwright server for browser automation.

## Requirements

- Node.js 18.18+ (or newer)
- npm

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Server starts on `http://localhost:3000` by default.

## Environment Variables

- `PORT` (default: `3000`)
- `HEADLESS` (default: `true`)
- `DEFAULT_TIMEOUT_MS` (default: `10000`)
- `MAX_RETRIES` (default: `3`)
- `SCREENSHOT_DIR` (default: `screenshots`)

Example:

```bash
set HEADLESS=false && npm start
```

## Response Format

All endpoints return:

```json
{
  "status": "success | error",
  "action": "",
  "data": {},
  "error": ""
}
```

## Quick API Test Flow

### 1) Health check

```bash
curl http://localhost:3000/health
```

### 2) Open a URL

```bash
curl -X POST http://localhost:3000/open ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"https://example.com\",\"headless\":true}"
```

Response includes `data.sessionId`. Save it for next calls.

### 3) Analyze page DOM

```bash
curl "http://localhost:3000/analyze?sessionId=YOUR_SESSION_ID"
```

### 4) Click an element

```bash
curl -X POST http://localhost:3000/click ^
  -H "Content-Type: application/json" ^
  -d "{\"sessionId\":\"YOUR_SESSION_ID\",\"selector\":\"a[href='https://www.iana.org/domains/example']\"}"
```

### 5) Type into an input

```bash
curl -X POST http://localhost:3000/type ^
  -H "Content-Type: application/json" ^
  -d "{\"sessionId\":\"YOUR_SESSION_ID\",\"selector\":\"input[name='q']\",\"text\":\"playwright automation\"}"
```

### 6) Scroll page

```bash
curl -X POST http://localhost:3000/scroll ^
  -H "Content-Type: application/json" ^
  -d "{\"sessionId\":\"YOUR_SESSION_ID\",\"pixels\":800}"
```

### 7) Capture screenshot

```bash
curl "http://localhost:3000/screenshot?sessionId=YOUR_SESSION_ID&fileName=example.png"
```

### 8) Read console/network failures

```bash
curl "http://localhost:3000/errors?sessionId=YOUR_SESSION_ID"
```

### 9) List sessions

```bash
curl http://localhost:3000/sessions
```

### 10) Close a session

```bash
curl -X DELETE http://localhost:3000/session/YOUR_SESSION_ID
```

## Agent Activity & Manual Interaction Blocking

When the MCP agent is performing browser automation (e.g., clicking, typing, navigating), the system automatically prevents manual user interactions to avoid conflicts. This feature includes:

### Visual Feedback
- A semi-transparent overlay appears when the agent is active
- A "Agent is running..." message is displayed in the top-right corner
- If a user tries to interact while the agent is active, a temporary message appears: "⏳ Agent is currently controlling the browser. Please wait..."

### How It Works
1. When any agent action starts (via `/click`, `/type`, `/open`, etc.), the browser page sets `window.__mcpAgentActive = true`
2. Event listeners intercept user interactions (clicks, keystrokes, etc.)
3. If the agent is active, interactions are blocked and a notification is shown
4. The agent activity state is tracked per browser session

### Monitoring Agent Activity
You can monitor agent activity via:
- `GET /agent/state` - Returns current agent status
- `GET /agent/events` - Server-Sent Events (SSE) stream for real-time updates

### Manual Interaction Detection
Even when the agent is not active, manual user interactions are detected and logged via:
- Server-side notifications sent to connected SSE clients
- Session scratchpad entries: "⚠ Manual user interaction detected"

## Endpoints

- `POST /open`
- `POST /click`
- `POST /type`
- `POST /scroll`
- `POST /hover`
- `POST /wait`
- `POST /select`
- `POST /upload`
- `POST /plan`
- `POST /flow/:template`
- `GET /agent/events`
- `GET /agent/state`
- `GET /screenshot`
- `GET /analyze`
- `GET /errors`
- `GET /sessions`
- `DELETE /session/:sessionId`
- `GET /health`

