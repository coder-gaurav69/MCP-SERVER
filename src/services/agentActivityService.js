class AgentActivityService {
  constructor() {
    this.isAgentWorking = false;
    this.currentAction = "";
    this.activeRequestCount = 0;
    this.lastUpdatedAt = null;
    this.clients = new Set();
  }

  getState() {
    return {
      isAgentWorking: this.isAgentWorking,
      currentAction: this.currentAction,
      activeRequestCount: this.activeRequestCount,
      lastUpdatedAt: this.lastUpdatedAt
    };
  }

  formatActionMessage(action) {
    if (!action) return "Agent is working...";
    const normalized = String(action).replace(/[_-]/g, " ").trim();
    if (!normalized) return "Agent is working...";
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}...`;
  }

  start(action = "") {
    this.activeRequestCount += 1;
    this.isAgentWorking = this.activeRequestCount > 0;
    this.currentAction = this.formatActionMessage(action);
    this.lastUpdatedAt = new Date().toISOString();
    this.broadcast("agent.activity", this.getState());
  }

  end() {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.isAgentWorking = this.activeRequestCount > 0;
    if (!this.isAgentWorking) {
      this.currentAction = "";
    }
    this.lastUpdatedAt = new Date().toISOString();
    this.broadcast("agent.activity", this.getState());
  }

  addClient(res) {
    this.clients.add(res);
    this.send(res, "agent.activity", this.getState());
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  send(res, event, payload) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast(event, payload) {
    for (const client of this.clients) {
      this.send(client, event, payload);
    }
  }
}

export const agentActivityService = new AgentActivityService();
