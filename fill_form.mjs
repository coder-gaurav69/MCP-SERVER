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

// Wait a bit for server to start
setTimeout(() => {
    // First, analyze the page to see form fields
    const analyzeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: 'browser_analyze',
            arguments: {
                sessionId: '322e6ee3-d26e-4786-afcf-37cd140333f9'
            }
        }
    };

    console.log('Sending analyze request...');
    server.stdin.write(JSON.stringify(analyzeRequest) + '\n');

    // Wait for response then fill form
    setTimeout(() => {
        // We'll need to see the analysis first to know what fields to fill
        // For now, let's just take a screenshot
        const screenshotRequest = {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'browser_screenshot',
                arguments: {
                    sessionId: '322e6ee3-d26e-4786-afcf-37cd140333f9',
                    fullPage: true
                }
            }
        };

        console.log('Sending screenshot request...');
        server.stdin.write(JSON.stringify(screenshotRequest) + '\n');

        // Then generate PDF
        setTimeout(() => {
            const pdfRequest = {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: {
                    name: 'browser_generate_pdf',
                    arguments: {
                        sessionId: '322e6ee3-d26e-4786-afcf-37cd140333f9'
                    }
                }
            };

            console.log('Sending PDF request...');
            server.stdin.write(JSON.stringify(pdfRequest) + '\n');

            // Close after a bit
            setTimeout(() => {
                server.stdin.end();
            }, 2000);
        }, 2000);
    }, 3000);
}, 1000);