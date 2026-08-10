import { ContextManager } from "./context-manager.js";
import { buildSystemPrompt } from "./prompts.js";
import { RepoMapper } from "./repo-mapper.js";
import { TOOL_DEFINITIONS, ToolRunner } from "./tools.js";
import { normalizeAgentConfig } from "./config.js";
import { serializeContext } from "./context-messages.js";
import { ToolEvidenceManager } from "./tool-evidence.js";
import { ContextInventory } from "./context-inventory.js";
import { StateTransferCompactor } from "./state-transfer-compactor.js";

function assistantContent(message) {
  if (typeof message.content === "string" && message.content.trim()) return message.content;
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return message.reasoning_content;
  return "";
}

function parseToolArguments(toolCall) {
  const raw = toolCall?.function?.arguments ?? "{}";
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON arguments for ${toolCall?.function?.name}: ${error.message}`);
  }
}

export class AgentRuntime {
  constructor({ projectRoot, config, client, memory, confirm, autoApprove = false, onEvent = () => {} }) {
    this.projectRoot = projectRoot;
    this.config = normalizeAgentConfig(config);
    this.client = client;
    this.memory = memory;
    this.onEvent = onEvent;
    this.mapper = new RepoMapper(projectRoot, memory);
    this.context = new ContextManager(this.config);
    this.stateTransferCompactor = new StateTransferCompactor({ client });
    this.toolRunner = new ToolRunner({ projectRoot, memory, mapper: this.mapper, config: this.config, confirm, autoApprove });
    this.evidence = new ToolEvidenceManager({ memory, config: this.config });
    this.inventory = new ContextInventory({ sessionId: memory.sessionId });
    this.durabilityMetrics = { artifactsCreated: 0, artifactCharsPersisted: 0 };
    this.messages = [];
    this.contextGeneration = 0;
    this.resetConversation();
  }

  replaceMessages(messages) {
    if (!Array.isArray(messages)) throw new Error("Runtime messages must be an array");
    this.messages = messages;
    this.contextGeneration += 1;
  }

  appendMessage(message) {
    this.replaceMessages([...this.messages, message]);
  }

  ensureRepoMap() {
    const current = this.memory.readRepoMap();
    if (!current.generatedAt) return this.mapper.build();
    return current;
  }

  systemPrompt() {
    const map = this.ensureRepoMap();
    return buildSystemPrompt({
      projectRoot: this.projectRoot,
      state: this.memory.getState(),
      projectMemory: this.memory.readProjectMemory(),
      episodes: this.memory.listEpisodes(6),
      artifacts: this.memory.listArtifacts(12),
      repoMapSummary: this.mapper.summarize(map)
    });
  }

  resetConversation() {
    this.replaceMessages([{ role: "system", content: this.systemPrompt() }]);
    this.syncInventory();
    this.memory.appendSession({ type: "conversation_reset" });
  }

  refreshSystemPrompt() {
    const messages = [...this.messages];
    messages[0] = { role: "system", content: this.systemPrompt() };
    this.replaceMessages(messages);
  }

  syncInventory() {
    return this.inventory.synchronize(this.messages, { taskId: this.memory.sessionId });
  }

  contextInventory(options = {}) {
    this.syncInventory();
    return this.inventory.snapshot(options);
  }

  async checkHealth() {
    const [health, models] = await Promise.all([this.client.health(), this.client.models()]);
    return { health, models: models.data?.map((model) => model.id) ?? [] };
  }

  async compactMessages(messages) {
    const compactor = this.stateTransferCompactor ?? new StateTransferCompactor({ client: this.client });
    return compactor.compact(messages);
  }

  async prepareContext(options = {}) {
    this.syncInventory();
    const prepared = await this.context.prepare(this.messages, (older) => this.compactMessages(older), {
      ...options,
      tools: TOOL_DEFINITIONS,
      durabilityMetrics: this.durabilityMetrics
    });
    this.replaceMessages(prepared.messages);
    const inventory = this.syncInventory();
    prepared.report.inventory = inventory.stats;
    if (prepared.stateTransfer) this.memory.updateState({ stateTransfer: prepared.stateTransfer });
    if (prepared.report.actions.length) {
      this.onEvent({ type: "context", ...prepared.report });
      this.memory.appendSession({ type: "context_compaction", report: prepared.report });
    }
    if (prepared.report.failure) throw new Error("Context manager remained above the 90% failure threshold after compaction.");
    return prepared.report;
  }

  async forceCompact() {
    const report = await this.prepareContext({ force: true });
    return report;
  }

  async runTurn(userText) {
    this.refreshSystemPrompt();
    this.appendMessage({ role: "user", content: userText });
    this.syncInventory();
    this.memory.appendSession({ type: "message", role: "user", content: userText });

    for (let iteration = 0; iteration < this.config.maxToolIterations; iteration += 1) {
      await this.prepareContext();
      const { message, usage } = await this.client.chat(serializeContext(this.messages), {
        tools: TOOL_DEFINITIONS,
        maxTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature
      });
      const assistant = {
        role: "assistant",
        content: message.content ?? ""
      };
      if (message.tool_calls?.length) assistant.tool_calls = message.tool_calls;
      if (message.reasoning_content) assistant.reasoning_content = message.reasoning_content;
      this.appendMessage(assistant);
      this.syncInventory();
      this.memory.appendSession({ type: "message", role: "assistant", content: assistant.content, toolCalls: assistant.tool_calls, usage });

      const visible = assistantContent(message);
      if (visible && (!message.tool_calls?.length || message.content?.trim())) this.onEvent({ type: "assistant", content: visible });
      if (!message.tool_calls?.length) return { content: visible, usage };

      for (const toolCall of message.tool_calls) {
        const name = toolCall.function.name;
        let args = {};
        let result;
        this.onEvent({ type: "tool_start", name });
        try {
          args = parseToolArguments(toolCall);
          result = await this.toolRunner.execute(name, args);
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        const evidence = this.evidence.createToolMessage({ toolCallId: toolCall.id, name, arguments: args, result });
        this.durabilityMetrics.artifactsCreated += evidence.metrics.artifactsCreated;
        this.durabilityMetrics.artifactCharsPersisted += evidence.metrics.artifactCharsPersisted;
        this.appendMessage(evidence.message);
        this.syncInventory();
        this.memory.appendSession({
          type: "tool_result",
          name,
          arguments: args,
          result,
          evidence: evidence.message.context_os
        });
        this.onEvent({ type: "tool_end", name, ok: result?.ok !== false, denied: result?.denied === true });
        if (["update_working_state", "save_episode", "build_repo_map"].includes(name)) this.refreshSystemPrompt();
      }
    }
    throw new Error(`Tool loop exceeded ${this.config.maxToolIterations} iterations.`);
  }
}
