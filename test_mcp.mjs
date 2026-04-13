// Test script to call MCP tool using ES modules
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read mcp.json
const mcpConfig = JSON.parse(readFileSync(join(__dirname, 'mcp.json'), 'utf8'));
const browserConfig = mcpConfig.mcpServers['browser-automation'];

// Start the MCP server
const server = spawn(browserConfig.command, browserConfig.args, {
    env: { ...process.env, ...browserConfig.env },
    stdio: ['pipe', 'pipe', 'pipe']
});

// Send MCP request to open browser
const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
        name: 'browser_open',
        arguments: {
            url: 'https://nextgen-invoice.onrender.com/'
        }
    }
};

server.stdin.write(JSON.stringify(request) + '\n');
server.stdin.end();

let output = '';
server.stdout.on('data', (data) => {
    output += data.toString();
    console.log('Received:', data.toString());
});

server.stderr.on('data', (data) => {
    console.error('Error:', data.toString());
});

server.on('close', (code) => {
    console.log(`Server exited with code ${code}`);
    console.log('Full output:', output);
});

// Kill after 5 seconds
setTimeout(() => {
    server.kill();
}, 5000);