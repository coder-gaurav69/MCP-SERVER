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

