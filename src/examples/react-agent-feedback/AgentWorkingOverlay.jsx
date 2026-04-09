import { useAgentActivity } from "./AgentActivityProvider";

export function AgentWorkingOverlay() {
  const { isAgentWorking, agentMessage } = useAgentActivity();
  if (!isAgentWorking) return null;

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50 h-1 bg-blue-500/70" />
      <div className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[1px] pointer-events-auto">
        <div className="absolute top-4 right-4 rounded-md bg-white px-3 py-2 text-sm shadow">
          <p className="font-medium text-gray-900">{agentMessage || "Agent is working..."}</p>
          <p className="text-gray-600">Live changes in progress</p>
        </div>
      </div>
    </>
  );
}

export function AgentInteractionLock({ children }) {
  const { isAgentWorking } = useAgentActivity();
  return (
    <div className={isAgentWorking ? "pointer-events-none opacity-50 cursor-not-allowed transition-opacity" : ""}>
      {children}
    </div>
  );
}
