import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { truncateMiddle } from "./utils.js";

const JSON_MIME = "application/json";

function boundedJson(value, maximumBytes) {
  const exact = JSON.stringify(value, null, 2);
  const originalBytes = Buffer.byteLength(exact, "utf8");
  if (originalBytes <= maximumBytes) return exact;
  let previewCharacters = Math.min(exact.length, Math.floor(maximumBytes / 2));
  while (previewCharacters > 0) {
    const output = JSON.stringify({
      schemaVersion: 1,
      truncated: true,
      originalBytes,
      preview: truncateMiddle(exact, previewCharacters)
    }, null, 2);
    if (Buffer.byteLength(output, "utf8") <= maximumBytes) return output;
    previewCharacters = Math.floor(previewCharacters * 0.75);
  }
  return JSON.stringify({ schemaVersion: 1, truncated: true, originalBytes, preview: "" });
}

function resource(uri, value, maximumBytes) {
  return {
    contents: [{ uri: uri.toString(), mimeType: JSON_MIME, text: boundedJson(value, maximumBytes) }]
  };
}

export function registerMcpResources(server, { memory, maximumBytes = 128 * 1024 }) {
  if (!server || !memory) throw new Error("MCP resource registration requires server and memory");
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4096 || maximumBytes > 1024 * 1024) {
    throw new Error("MCP resource maximumBytes must be between 4096 and 1048576");
  }

  server.registerResource("repository-map", "contextos://repository/map", {
    title: "ContextOS repository map",
    description: "Current Runtime-derived repository file and symbol map.",
    mimeType: JSON_MIME
  }, async (uri) => resource(uri, memory.readRepoMap(), maximumBytes));

  server.registerResource("project-memory", "contextos://memory/project", {
    title: "ContextOS project memory",
    description: "Human-editable durable project memory for the selected root.",
    mimeType: JSON_MIME
  }, async (uri) => resource(uri, {
    schemaVersion: 1,
    content: memory.readProjectMemory()
  }, maximumBytes));

  server.registerResource("working-state", "contextos://state/working", {
    title: "ContextOS working state",
    description: "Durable task continuation state. It is derived state, not repository truth.",
    mimeType: JSON_MIME
  }, async (uri) => resource(uri, memory.getState(), maximumBytes));

  server.registerResource("artifact-index", "contextos://artifacts", {
    title: "ContextOS artifact index",
    description: "Bounded metadata for durable tool-evidence artifacts.",
    mimeType: JSON_MIME
  }, async (uri) => resource(uri, {
    schemaVersion: 1,
    artifacts: memory.listArtifacts(100)
  }, maximumBytes));

  const artifactTemplate = new ResourceTemplate("contextos://artifacts/{artifactId}", {
    list: async () => ({
      resources: memory.listArtifacts(100).map((artifact) => ({
        uri: `contextos://artifacts/${encodeURIComponent(artifact.id)}`,
        name: artifact.id,
        title: `Artifact ${artifact.id}`,
        description: `${artifact.tool ?? artifact.kind ?? "tool"} evidence (${artifact.bytes ?? "unknown"} bytes)`,
        mimeType: JSON_MIME
      }))
    })
  });
  server.registerResource("artifact", artifactTemplate, {
    title: "ContextOS artifact",
    description: "Bounded exact durable tool evidence with SHA-256 integrity validation.",
    mimeType: JSON_MIME
  }, async (uri, variables) => resource(uri, memory.readArtifact(String(variables.artifactId)), maximumBytes));
}

export { boundedJson };
