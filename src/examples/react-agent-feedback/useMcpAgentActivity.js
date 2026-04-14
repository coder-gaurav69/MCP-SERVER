import { useEffect } from "react";
import { useAgentActivity } from "./AgentActivityProvider.js";

function toLabel(action) {
  if (!action) return "Agent is working...";
  return `${String(action).replace(/[_-]/g, " ").trim()}...`;
}

export function useMcpAgentActivity(mcpBaseUrl = "http://localhost:1000") {
  const { startAgentWork, endAgentWork } = useAgentActivity();

  useEffect(() => {
    const source = new EventSource(`${mcpBaseUrl}/agent/events`);

    source.addEventListener("agent.activity", (event) => {
      const payload = JSON.parse(event.data || "{}");
      if (payload?.isAgentWorking) {
        startAgentWork(payload.currentAction || "Agent is working...");
      } else {
        endAgentWork();
      }
    });

    source.onerror = () => {
      endAgentWork();
    };

    return () => {
      source.close();
    };
  }, [mcpBaseUrl, startAgentWork, endAgentWork]);
}

export async function runMcpToolCall({
  mcpBaseUrl = "http://localhost:1000",
  endpoint,
  body,
  method = "POST",
  startAgentWork,
  endAgentWork
}) {
  startAgentWork(toLabel(endpoint));
  try {
    const response = await fetch(`${mcpBaseUrl}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok || data?.status === "error") {
      throw new Error(data?.error || `MCP call failed: ${endpoint}`);
    }
    return data;
  } finally {
    endAgentWork();
  }
}
