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
let sessionId = null;

server.stdout.on('data', (data) => {
    const dataStr = data.toString();
    output += dataStr;
    console.log('Received:', dataStr);

    // Try to parse JSON responses
    const lines = dataStr.split('\n');
    for (const line of lines) {
        if (line.trim()) {
            try {
                const response = JSON.parse(line);
                if (response.result && response.result.content) {
                    const content = response.result.content[0]?.text;
                    if (content) {
                        const parsed = JSON.parse(content);
                        if (parsed.ok && parsed.sessionId) {
                            sessionId = parsed.sessionId;
                            console.log('Session ID:', sessionId);
                        }
                    }
                }
            } catch (e) {
                // Not JSON, continue
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

// Wait for server to start
setTimeout(() => {
    console.log('Opening browser...');

    // First, open the browser
    const openRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: 'browser_open',
            arguments: {
                url: 'https://nextgen-invoice.onrender.com/',
                headless: false
            }
        }
    };

    server.stdin.write(JSON.stringify(openRequest) + '\n');

    // Wait for session to be created
    setTimeout(() => {
        if (!sessionId) {
            console.log('No session ID received, using default');
            sessionId = 'default-session-' + Date.now();
        }

        console.log('Analyzing page...');

        // Analyze the page to understand form structure
        const analyzeRequest = {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'browser_analyze',
                arguments: {
                    sessionId: sessionId
                }
            }
        };

        server.stdin.write(JSON.stringify(analyzeRequest) + '\n');

        // Wait for analysis, then fill form
        setTimeout(() => {
            console.log('Filling form...');

            // Fill the form with sample data
            // We'll need to adjust based on actual form fields from analysis
            const fillFormRequest = {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: {
                    name: 'browser_fill_form',
                    arguments: {
                        sessionId: sessionId,
                        fields: [
                            // Common invoice form fields
                            { query: "invoice number", value: "INV-2024-001" },
                            { query: "date", value: "2024-04-13" },
                            { query: "customer name", value: "John Doe" },
                            { query: "customer email", value: "john@example.com" },
                            { query: "address", value: "123 Main St, City, Country" },
                            { query: "item description", value: "Web Development Services" },
                            { query: "quantity", value: "5" },
                            { query: "price", value: "100.00" },
                            { query: "tax", value: "10" },
                            { query: "total", value: "550.00" }
                        ]
                    }
                }
            };

            server.stdin.write(JSON.stringify(fillFormRequest) + '\n');

            // Wait for form to be filled
            setTimeout(() => {
                console.log('Taking screenshot...');

                // Take screenshot
                const screenshotRequest = {
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: {
                        name: 'browser_screenshot',
                        arguments: {
                            sessionId: sessionId,
                            fullPage: true,
                            embedImage: true
                        }
                    }
                };

                server.stdin.write(JSON.stringify(screenshotRequest) + '\n');

                // Wait for screenshot
                setTimeout(() => {
                    console.log('Generating PDF...');

                    // Generate PDF
                    const pdfRequest = {
                        jsonrpc: '2.0',
                        id: 5,
                        method: 'tools/call',
                        params: {
                            name: 'browser_generate_pdf',
                            arguments: {
                                sessionId: sessionId
                            }
                        }
                    };

                    server.stdin.write(JSON.stringify(pdfRequest) + '\n');

                    // Close after a bit
                    setTimeout(() => {
                        console.log('Closing session...');

                        const closeRequest = {
                            jsonrpc: '2.0',
                            id: 6,
                            method: 'tools/call',
                            params: {
                                name: 'browser_close_session',
                                arguments: {
                                    sessionId: sessionId,
                                    cleanup: true
                                }
                            }
                        };

                        server.stdin.write(JSON.stringify(closeRequest) + '\n');

                        setTimeout(() => {
                            server.stdin.end();
                        }, 2000);
                    }, 3000);
                }, 2000);
            }, 3000);
        }, 3000);
    }, 3000);
}, 1000);