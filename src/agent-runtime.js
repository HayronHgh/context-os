import { ContextManager } from "./context-manager.js";
import { COMPACTION_SYSTEM_PROMPT, buildSystemPrompt } from "./prompts.js";
import { RepoMapper } from "./repo-mapper.js";
import { TOOL_DEFINITIONS, ToolRunner } from "./tools.js";
import { truncateMiddle } from "./utils.js";
import { formatStateTransfer, parseStateTransfer } from "./state-transfer.js";

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

function stripCodeFence(text) {
  return String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export class AgentRuntime {
  constructor({ projectRoot, config, client, memory, confirm, autoApprove = false, onEvent = () => {} }) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.client = client;
    this.memory = memory;
    this.onEvent = onEvent;
    this.mapper = new RepoMapper(projectRoot, memory);
    this.context = new ContextManager(config);
    this.toolRunner = new ToolRunner({ projectRoot, memory, mapper: this.mapper, config, confirm, autoApprove });
    this.messages = [];
    this.resetConversation();
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
      repoMapSummary: this.mapper.summarize(map)
    });
  }

  resetConversation() {
    this.messages = [{ role: "system", content: this.systemPrompt() }];
    this.memory.appendSession({ type: "conversation_reset" });
  }

  refreshSystemPrompt() {
    this.messages[0] = { role: "system", content: this.systemPrompt() };
  }

  async checkHealth() {
    const [health, models] = await Promise.all([this.client.health(), this.client.models()]);
    return { health, models: models.data?.map((model) => model.id) ?? [] };
  }

  async compactMessages(messages) {
    const transcript = messages.map((message) => ({
      role: message.role,
      name: message.name,
      content: truncateMiddle(message.content ?? "", 14000),
      tool_calls: message.tool_calls
    }));
    const request = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(transcript) }
    ];
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retryInstruction = attempt === 1 ? [] : [{
        role: "user",
        content: `Your previous state transfer was invalid: ${lastError.message}\nReturn a corrected JSON object matching every required field and no additional fields.`
      }];
      const { message } = await this.client.chat([...request, ...retryInstruction], { maxTokens: 2400, temperature: 0.1 });
      const text = stripCodeFence(assistantContent(message));
      try {
        return formatStateTransfer(parseStateTransfer(text));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`State transfer validation failed after 2 attempts: ${lastError.message}`);
  }

  async prepareContext(options = {}) {
    const prepared = await this.context.prepare(this.messages, (older) => this.compactMessages(older), {
      ...options,
      tools: TOOL_DEFINITIONS
    });
    this.messages = prepared.messages;
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

  formatToolResult(name, args, result) {
    const full = JSON.stringify(result, null, 2);
    if (full.length <= this.config.maxToolOutputChars) return full;
    const artifact = this.memory.saveArtifact(full, name, { tool: name, arguments: args });
    return JSON.stringify({
      artifact: pathForPrompt(this.projectRoot, artifact.file),
      note: "Full tool output was externalized. Read the artifact only if needed.",
      preview: truncateMiddle(full, this.config.maxToolOutputChars)
    }, null, 2);
  }

  async runTurn(userText) {
    this.refreshSystemPrompt();
    this.messages.push({ role: "user", content: userText });
    this.memory.appendSession({ type: "message", role: "user", content: userText });

    for (let iteration = 0; iteration < this.config.maxToolIterations; iteration += 1) {
      await this.prepareContext();
      const { message, usage } = await this.client.chat(this.messages, {
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
      this.messages.push(assistant);
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
        const content = this.formatToolResult(name, args, result);
        this.messages.push({ role: "tool", tool_call_id: toolCall.id, name, content });
        this.memory.appendSession({ type: "tool_result", name, arguments: args, result });
        this.onEvent({ type: "tool_end", name, ok: result?.ok !== false, denied: result?.denied === true });
        if (["update_working_state", "save_episode", "build_repo_map"].includes(name)) this.refreshSystemPrompt();
      }
    }
    throw new Error(`Tool loop exceeded ${this.config.maxToolIterations} iterations.`);
  }
}

function pathForPrompt(projectRoot, file) {
  return file.startsWith(projectRoot) ? file.slice(projectRoot.length + 1).replaceAll("\\", "/") : file;
}
