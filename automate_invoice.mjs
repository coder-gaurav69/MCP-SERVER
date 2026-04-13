import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
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
let sessionId = null;
let requestId = 1;

server.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    console.log('Received:', text);

    // Try to parse JSON responses
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.trim().startsWith('{')) {
            try {
                const response = JSON.parse(line.trim());
                if (response.result && response.result.content) {
                    const content = response.result.content[0].text;
                    const data = JSON.parse(content);
                    if (data.ok && data.data && data.data.sessionId) {
                        sessionId = data.data.sessionId;
                        console.log(`Session ID: ${sessionId}`);
                    }
                }
            } catch (e) {
                // Not JSON or parse error, ignore
            }
        }
    }
});

server.stderr.on('data', (data) => {
    console.error('Error:', data.toString());
});

server.on('close', (code) => {
    console.log(`Server exited with code ${code}`);
    console.log('Full output:', output);
});

// Function to send request
function sendRequest(method, args) {
    const request = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
            name: method,
            arguments: args
        }
    };
    console.log(`Sending ${method} request...`);
    server.stdin.write(JSON.stringify(request) + '\n');
}

// Wait for server to start, then execute sequence
setTimeout(() => {
    // 1. Open browser
    sendRequest('browser_open', {
        url: 'https://nextgen-invoice.onrender.com/',
        headless: false
    });

    // Wait for page to load
    setTimeout(() => {
        if (!sessionId) {
            console.error('No session ID received');
            server.stdin.end();
            return;
        }

        // 2. Analyze page to see form fields
        sendRequest('browser_analyze', { sessionId });

        // Wait for analysis
        setTimeout(() => {
            // 3. Fill form - we need to know the fields first
            // For now, let's try to fill common invoice form fields
            // We'll use browser_fill_form with guessed selectors
            const formData = {
                sessionId,
                fields: [
                    {
                        selector: 'input[name="customerName"], input[placeholder*="Customer"], input[placeholder*="Name"]',
                        value: 'John Doe'
                    },
                    {
                        selector: 'input[name="email"], input[type="email"], input[placeholder*="Email"]',
                        value: 'john.doe@example.com'
                    },
                    {
                        selector: 'input[name="address"], textarea[name="address"], input[placeholder*="Address"]',
                        value: '123 Main St, City, Country'
                    },
                    {
                        selector: 'input[name="invoiceNumber"], input[placeholder*="Invoice"], input[placeholder*="Number"]',
                        value: 'INV-2024-001'
                    },
                    {
                        selector: 'input[name="date"], input[type="date"], input[placeholder*="Date"]',
                        value: '2024-04-12'
                    },
                    {
                        selector: 'input[name="amount"], input[type="number"], input[placeholder*="Amount"]',
                        value: '999.99'
                    }
                ]
            };

            sendRequest('browser_fill_form', formData);

            // Wait for form fill
            setTimeout(() => {
                // 4. Take screenshot
                sendRequest('browser_screenshot', {
                    sessionId,
                    fullPage: true,
                    embedImage: false  // Will save to file
                });

                // 5. Generate PDF
                setTimeout(() => {
                    sendRequest('browser_generate_pdf', { sessionId });

                    // Close after a bit
                    setTimeout(() => {
                        console.log('Closing session...');
                        sendRequest('browser_close_session', { sessionId });

                        setTimeout(() => {
                            server.stdin.end();
                        }, 1000);
                    }, 3000);
                }, 3000);
            }, 3000);
        }, 3000);
    }, 3000);
}, 1000);