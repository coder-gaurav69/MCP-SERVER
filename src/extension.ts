import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let mcpProcess: cp.ChildProcess | undefined;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

/**
 * Activates the extension.
 * Starts the MCP server and sets up the status bar indicator.
 */
export function activate(context: vscode.ExtensionContext) {
    // Initialize Output Channel
    outputChannel = vscode.window.createOutputChannel("MCP Server Console");
    
    // Initialize Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    // Start the server
    startServer(context);

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('mcp.serverPath')) {
                outputChannel.appendLine("MCP configuration changed. Restarting server...");
                restartServer(context);
            }
        })
    );

    // Command to copy Copilot Config
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-manager.copyCopilotConfig', async () => {
            const port = await getPort(context);
            const config = {
                "github.copilot.chat.mcp.servers": {
                    "browser-automation": {
                        "type": "sse",
                        "url": `http://127.0.0.1:${port}/mcp/sse`
                    }
                }
            };
            const configStr = JSON.stringify(config, null, 2);
            await vscode.env.clipboard.writeText(configStr);
            vscode.window.showInformationMessage("GitHub Copilot MCP configuration copied to clipboard! Paste it into your settings.json.");
        })
    );
}

/**
 * Restarts the MCP server process.
 */
function restartServer(context: vscode.ExtensionContext) {
    stopServer();
    startServer(context);
}

/**
 * Starts the Node.js MCP server process.
 */
async function startServer(context: vscode.ExtensionContext) {
    if (mcpProcess) {
        outputChannel.appendLine("MCP Server is already running.");
        return;
    }

    updateStatus("🟡 MCP Starting...");
    outputChannel.appendLine("Extension activation started...");

    const serverPath = await findServerPath(context);
    if (!serverPath) {
        updateStatus("🔴 MCP Stopped");
        outputChannel.appendLine("Error: MCP Server path not found. Please check your settings or ensure the server is in the extension folder.");
        return;
    }

    if (!fs.existsSync(serverPath)) {
        updateStatus("🔴 MCP Stopped");
        outputChannel.appendLine(`Error: File does not exist at path: ${serverPath}`);
        vscode.window.showErrorMessage(`MCP Server not found at: ${serverPath}`);
        return;
    }

    vscode.window.showInformationMessage(`Starting MCP Server: ${path.basename(serverPath)}`);

    const serverCwd = path.dirname(serverPath);
    const port = await getPort(context);
    
    outputChannel.appendLine(`Working Directory: ${serverCwd}`);
    outputChannel.appendLine(`Target Port: ${port}`);
    outputChannel.appendLine(`Ensuring port ${port} is free...`);
    await killPortProcess(port);

    outputChannel.appendLine(`Spawning MCP Server: node "${path.basename(serverPath)}"`);
    
    try {
        mcpProcess = cp.spawn('node', [path.basename(serverPath)], {
            cwd: serverCwd,
            env: { ...process.env },
            shell: true
        });

        // Log stdout
        mcpProcess.stdout?.on('data', (data) => {
            outputChannel.append(`[STDOUT] ${data.toString()}`);
        });

        // Log stderr
        let lastError = "";
        mcpProcess.stderr?.on('data', (data) => {
            lastError = data.toString();
            outputChannel.append(`[STDERR] ${lastError}`);
        });

        // Handle process errors
        mcpProcess.on('error', (err) => {
            outputChannel.appendLine(`[PROCESS ERROR] ${err.message}`);
            updateStatus("🔴 MCP Stopped");
            vscode.window.showErrorMessage(`MCP Server Error: ${err.message}`);
            mcpProcess = undefined;
        });

        // Handle process exit
        mcpProcess.on('close', (code) => {
            outputChannel.appendLine(`MCP Server process exited with code ${code}`);
            updateStatus("🔴 MCP Stopped");
            if (code !== 0 && code !== null) {
                vscode.window.showErrorMessage(`MCP Server crashed (Exit Code: ${code}). Last error: ${lastError}`);
            }
            mcpProcess = undefined;
        });

        // Update status to running after a short delay to ensure it doesn't crash immediately
        const port = await getPort(context);
        updateStatus("🟢 MCP Running", `SSE URL: http://127.0.0.1:${port}/mcp/sse (Click to copy Copilot config)`);
        statusBarItem.command = 'mcp-manager.copyCopilotConfig';

    } catch (error: any) {
        outputChannel.appendLine(`[EXCEPTION] Failed to spawn MCP process: ${error.message}`);
        updateStatus("🔴 MCP Stopped");
        mcpProcess = undefined;
    }
}

/**
 * Port Management: Find and kill process on specific port
 */
async function killPortProcess(port: number): Promise<void> {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve(); // Basic support for Windows first
            return;
        }

        cp.exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
            if (err || !stdout) {
                resolve();
                return;
            }

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && !isNaN(parseInt(pid)) && pid !== '0') {
                    outputChannel.appendLine(`Cleaning up port ${port} (PID: ${pid})...`);
                    try {
                        cp.execSync(`taskkill /F /PID ${pid}`);
                    } catch (e) {
                        outputChannel.appendLine(`[PORT CLEANUP ERROR] Failed to kill PID ${pid}`);
                    }
                }
            }
            resolve();
        });
    });
}

/**
 * Simple helper to detect port from config or .env
 */
async function getPort(context: vscode.ExtensionContext): Promise<number> {
    const serverPath = await findServerPath(context);
    if (serverPath) {
        const envPath = path.join(path.dirname(serverPath), '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            const match = content.match(/^PORT\s*=\s*(\d+)/m);
            if (match) return parseInt(match[1]);
        }
    }
    return 1000; // Default fallback
}

/**
 * Kills the active MCP server process.
 */
function stopServer() {
    if (mcpProcess) {
        outputChannel.appendLine("Stopping MCP Server...");
        
        if (process.platform === 'win32' && mcpProcess.pid) {
            // Forcefully kill the process tree on Windows to prevent orphaned processes
            cp.exec(`taskkill /pid ${mcpProcess.pid} /T /F`, (err) => {
                if (err) {
                    outputChannel.appendLine(`[CLEANUP ERROR] ${err.message}`);
                } else {
                    outputChannel.appendLine("MCP Server process tree terminated.");
                }
            });
        } else {
            mcpProcess.kill();
        }
        
        mcpProcess = undefined;
    }
}

/**
 * Implementation of smart workspace detection:
 * 1. Checks for 'mcp-server.js' in the workspace root.
 * 2. Falls back to 'mcp.serverPath' setting.
 * 3. Fallback to extension internal source.
 */
async function findServerPath(context: vscode.ExtensionContext): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    // 1. Smart workspace detection: Check if mcp-server.js exists in the workspace root
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const workspaceRootPath = folder.uri.fsPath;
            const localMcpPath = path.join(workspaceRootPath, 'mcp-server.js');
            
            if (fs.existsSync(localMcpPath)) {
                outputChannel.appendLine(`Detected mcp-server.js in workspace: ${localMcpPath}`);
                return localMcpPath;
            }
        }
    }

    // 2. Setting Check (if default is changed or custom path provided)
    const config = vscode.workspace.getConfiguration('mcp');
    const globalPath = config.get<string>('serverPath');
    
    // If the path exists on disk, use it
    if (globalPath && fs.existsSync(globalPath)) {
        outputChannel.appendLine(`Using configured server path: ${globalPath}`);
        return globalPath;
    }

    // 3. Zero-Config Fallback: Check if the server is inside the extension folder itself
    // Try mcp-server.js first
    const extMcpPath = path.join(context.extensionPath, 'mcp-server.js');
    if (fs.existsSync(extMcpPath)) {
        outputChannel.appendLine(`Auto-detected server in extension folder: ${extMcpPath}`);
        return extMcpPath;
    }

    // Try src/server.js
    const extSrcPath = path.join(context.extensionPath, 'src', 'server.js');
    if (fs.existsSync(extSrcPath)) {
        outputChannel.appendLine(`Auto-detected server in extension folder: ${extSrcPath}`);
        return extSrcPath;
    }

    return undefined;
}

/**
 * Updates the Status Bar indicator text.
 */
function updateStatus(text: string, tooltip?: string) {
    if (statusBarItem) {
        statusBarItem.text = text;
        if (tooltip) {
            statusBarItem.tooltip = tooltip;
        } else {
            statusBarItem.tooltip = undefined;
        }
    }
}

/**
 * Deactivates the extension.
 * Ensures the MCP server is killed when the extension is disabled or VS Code is closed.
 */
export function deactivate() {
    stopServer();
}
