import { createContext, useCallback, useContext, useMemo, useState } from "react";

const AgentActivityContext = createContext(null);

export function AgentActivityProvider({ children }) {
  const [isAgentWorking, setIsAgentWorking] = useState(false);
  const [agentMessage, setAgentMessage] = useState("Agent is working...");

  const startAgentWork = useCallback((message = "Agent is working...") => {
    setAgentMessage(message);
    setIsAgentWorking(true);
  }, []);

  const endAgentWork = useCallback(() => {
    setIsAgentWorking(false);
    setAgentMessage("Agent is working...");
  }, []);

  const value = useMemo(
    () => ({
      isAgentWorking,
      agentMessage,
      startAgentWork,
      endAgentWork
    }),
    [isAgentWorking, agentMessage, startAgentWork, endAgentWork]
  );

  return <AgentActivityContext.Provider value={value}>{children}</AgentActivityContext.Provider>;
}

export function useAgentActivity() {
  const context = useContext(AgentActivityContext);
  if (!context) {
    throw new Error("useAgentActivity must be used within AgentActivityProvider");
  }
  return context;
}
