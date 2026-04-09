import { createApp } from "./app.js";
import { config } from "./config.js";
import { browserService } from "./services/browserService.js";

const app = createApp();

const server = app.listen(config.port, () => {
  process.stdout.write(`MCP browser server listening on http://localhost:${config.port}\n`);
});

const shutdown = async () => {
  await browserService.closeAll();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
