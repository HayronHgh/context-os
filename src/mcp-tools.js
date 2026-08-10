import { z } from "zod";
import { TOOL_DEFINITIONS } from "./tools.js";
import { timestampId } from "./utils.js";

export const MCP_READ_ONLY_TOOLS = Object.freeze([
  "read_file",
  "file_glob_search",
  "grep_search",
  "read_working_state",
  "read_artifact",
  "get_datetime"
]);

export const MCP_MUTATION_TOOLS = Object.freeze([
  "write_file",
  "edit_file",
  "run_command",
  "build_repo_map",
  "update_working_state",
  "save_episode"
]);

const MUTATION_TOOL_SET = new Set(MCP_MUTATION_TOOLS);

function schemaForProperty(schema) {
  let value;
  if (schema.type === "string") value = z.string();
  else if (schema.type === "integer") value = z.number().int();
  else if (schema.type === "boolean") value = z.boolean();
  else if (schema.type === "array") value = z.array(schemaForProperty(schema.items));
  else throw new Error(`Unsupported MCP tool schema type: ${schema.type}`);

  if (schema.minimum !== undefined) value = value.min(schema.minimum);
  if (schema.maximum !== undefined) value = value.max(schema.maximum);
  if (schema.description) value = value.describe(schema.description);
  return value;
}

function inputSchemaFor(definition) {
  const parameters = definition.function.parameters;
  const required = new Set(parameters.required ?? []);
  const shape = {};
  for (const [name, property] of Object.entries(parameters.properties ?? {})) {
    const schema = schemaForProperty(property);
    shape[name] = required.has(name) ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

function errorCode(error) {
  const message = String(error?.message ?? error);
  if (/escapes project root|symbolic link|junction/i.test(message)) return "PROJECT_ROOT_ESCAPE";
  if (/destructive command denied|disabled in config/i.test(message)) return "POLICY_DENIED";
  if (/artifact/i.test(message)) return "ARTIFACT_ERROR";
  if (/invalid/i.test(message)) return "INVALID_ARGUMENT";
  return "TOOL_EXECUTION_FAILED";
}

function resultStatus(result) {
  return result?.denied === true ? "denied" : result?.ok === false || result?.error ? "error" : "ok";
}

function evidenceMetadata(evidence) {
  const metadata = evidence.message.context_os;
  return {
    durable: metadata.durable,
    artifactId: metadata.artifactId,
    sha256: metadata.sha256,
    recoveryType: metadata.recoveryType,
    originalChars: metadata.originalChars,
    resultStatus: metadata.resultStatus
  };
}

function responseEnvelope({ name, result, evidence, error = null }) {
  const externalized = evidence.prepared.originalChars > evidence.message.content.length;
  return {
    schemaVersion: 1,
    ok: error === null && resultStatus(result) === "ok",
    tool: name,
    result: externalized
      ? { externalized: true, preview: evidence.message.content }
      : result,
    error,
    evidence: evidenceMetadata(evidence)
  };
}

function toolAnnotations(name) {
  const mutation = MUTATION_TOOL_SET.has(name);
  return {
    readOnlyHint: !mutation,
    destructiveHint: name === "write_file" || name === "edit_file" || name === "run_command",
    idempotentHint: ["read_file", "file_glob_search", "grep_search", "read_working_state", "read_artifact", "get_datetime"].includes(name),
    openWorldHint: name === "run_command"
  };
}

export function exposedToolDefinitions(mode = "read-only") {
  const allowed = mode === "trusted-local"
    ? new Set([...MCP_READ_ONLY_TOOLS, ...MCP_MUTATION_TOOLS])
    : new Set(MCP_READ_ONLY_TOOLS);
  return TOOL_DEFINITIONS.filter((definition) => allowed.has(definition.function.name));
}

export function registerMcpTools(server, { mode, runner, evidenceManager }) {
  if (!server || !runner || !evidenceManager) throw new Error("MCP tool registration requires server, runner, and evidence manager");
  if (!["read-only", "trusted-local"].includes(mode)) throw new Error(`Unsupported MCP mode: ${mode}`);

  for (const definition of exposedToolDefinitions(mode)) {
    const { name, description } = definition.function;
    server.registerTool(name, {
      description,
      inputSchema: inputSchemaFor(definition),
      annotations: toolAnnotations(name)
    }, async (args) => {
      let result;
      let error = null;
      try {
        if (MUTATION_TOOL_SET.has(name) && mode !== "trusted-local") {
          throw new Error("Mutation denied: MCP server is running in read-only mode");
        }
        result = await runner.execute(name, args);
        if (result?.denied === true) {
          error = { code: "APPROVAL_REQUIRED", message: result.message ?? "Mutation was not approved" };
        }
      } catch (caught) {
        error = { code: errorCode(caught), message: String(caught?.message ?? caught) };
        result = { ok: false, error };
      }

      const evidence = evidenceManager.createToolMessage({
        toolCallId: timestampId("mcp-call"),
        name,
        arguments: args,
        result
      });
      const envelope = responseEnvelope({ name, result, evidence, error });
      return {
        isError: envelope.ok === false,
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope
      };
    });
  }
}
