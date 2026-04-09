import { useState } from "react";
import { AgentActivityProvider, useAgentActivity } from "./AgentActivityProvider";
import { AgentInteractionLock, AgentWorkingOverlay } from "./AgentWorkingOverlay";
import { runMcpToolCall, useMcpAgentActivity } from "./useMcpAgentActivity";

function DemoForm() {
  const [sessionId, setSessionId] = useState("");
  const [url, setUrl] = useState("https://example.com");
  const [selector, setSelector] = useState("text=More information...");
  const { startAgentWork, endAgentWork, isAgentWorking } = useAgentActivity();

  useMcpAgentActivity("http://localhost:3000");

  const onOpen = async () => {
    const result = await runMcpToolCall({
      endpoint: "/open",
      body: { sessionId, url },
      startAgentWork,
      endAgentWork
    });
    setSessionId(result?.data?.sessionId || sessionId);
  };

  const onClick = async () => {
    await runMcpToolCall({
      endpoint: "/click",
      body: { sessionId, selector },
      startAgentWork,
      endAgentWork
    });
  };

  return (
    <div className="relative">
      <AgentWorkingOverlay />
      <AgentInteractionLock>
        <div className="space-y-3">
          <input
            className="w-full rounded border px-3 py-2"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isAgentWorking}
          />
          <input
            className="w-full rounded border px-3 py-2"
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
            disabled={isAgentWorking}
          />
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50" onClick={onOpen} disabled={isAgentWorking}>
              Open
            </button>
            <button className="rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50" onClick={onClick} disabled={isAgentWorking || !sessionId}>
              Click
            </button>
          </div>
          {isAgentWorking ? <p className="text-xs text-gray-600">Agent is working, please wait</p> : null}
        </div>
      </AgentInteractionLock>
    </div>
  );
}

export default function ExamplePage() {
  return (
    <AgentActivityProvider>
      <DemoForm />
    </AgentActivityProvider>
  );
}
