import { normalizeAgentConfig } from "./config.js";
import { truncateMiddle } from "./utils.js";

export function isDurableToolMessage(message) {
  const metadata = message?.context_os;
  return message?.role === "tool"
    && metadata?.durable === true
    && metadata?.recoveryType === "artifact"
    && typeof metadata?.artifactId === "string"
    && metadata.artifactId.length > 0;
}

export function recoveryReference(message) {
  if (!isDurableToolMessage(message)) return null;
  return {
    tool: message.name ?? "tool",
    artifactId: message.context_os.artifactId,
    originalChars: message.context_os.originalChars,
    sha256: message.context_os.sha256
  };
}

export class ToolEvidenceManager {
  constructor({ memory, config }) {
    this.memory = memory;
    this.config = normalizeAgentConfig(config);
  }

  prepareToolResult(name, arguments_, result) {
    const fullText = JSON.stringify(result, null, 2) ?? "null";
    return {
      name,
      arguments: arguments_,
      result,
      fullText,
      originalChars: fullText.length,
      bytes: Buffer.byteLength(fullText, "utf8")
    };
  }

  persistToolEvidence(prepared) {
    if (prepared.originalChars <= this.config.artifactPersistenceChars) return null;
    return this.memory.saveArtifact(prepared.fullText, prepared.name, {
      tool: prepared.name,
      arguments: prepared.arguments
    });
  }

  renderToolResult(prepared, artifact) {
    if (prepared.originalChars <= this.config.maxToolOutputChars) return prepared.fullText;
    if (!artifact) throw new Error("Oversized tool result has no durable recovery artifact");
    const header = [
      "[tool evidence externalized]",
      `${prepared.name} -> artifact: ${artifact.id}`,
      `originalChars: ${prepared.originalChars}`,
      `sha256: ${artifact.sha256}`,
      "preview:"
    ].join("\n") + "\n";
    const previewBudget = Math.max(0, this.config.maxToolOutputChars - header.length);
    return `${header}${truncateMiddle(prepared.fullText, previewBudget)}`;
  }

  createToolMessage({ toolCallId, name, arguments: arguments_, result }) {
    const prepared = this.prepareToolResult(name, arguments_, result);
    const artifact = this.persistToolEvidence(prepared);
    const content = this.renderToolResult(prepared, artifact);
    return {
      message: {
        role: "tool",
        tool_call_id: toolCallId,
        name,
        content,
        context_os: {
          originalChars: prepared.originalChars,
          durable: Boolean(artifact),
          artifactId: artifact?.id ?? null,
          recoveryType: artifact ? "artifact" : "context-only",
          sha256: artifact?.sha256 ?? null
        }
      },
      prepared,
      artifact,
      metrics: {
        artifactsCreated: artifact ? 1 : 0,
        artifactCharsPersisted: artifact ? prepared.originalChars : 0
      }
    };
  }
}
