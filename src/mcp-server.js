#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeAgentConfig } from "./config.js";
import { MemoryStore } from "./memory-store.js";
import { registerMcpResources } from "./mcp-resources.js";
import { registerMcpTools } from "./mcp-tools.js";
import { RepoMapper } from "./repo-mapper.js";
import { ToolEvidenceManager } from "./tool-evidence.js";
import { ToolRunner } from "./tools.js";
import { readJson } from "./utils.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(sourceDirectory, "..");
const VERSION = "0.2.0-dev.6";

export function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (["--project", "--config", "--mode"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

export function usage() {
  return `ContextOS MCP Capability Server ${VERSION}\n\nUsage:\n  node src/mcp-server.js [--project PATH] [--config FILE] [--mode read-only|trusted-local]\n\nOptions:\n  --project PATH  Selected repository root\n  --config FILE   MCP capability config (separate from llama.cpp inference config)\n  --mode MODE     Override capability mode; default is read-only\n  --help          Show this help\n`;
}

function integer(value, fallback, name, minimum, maximum) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

export function loadMcpSettings(args = {}) {
  const explicitConfig = args.config ? path.resolve(args.config) : null;
  const localConfig = path.join(applicationRoot, "config", "mcp.json");
  const exampleConfig = path.join(applicationRoot, "config", "mcp.example.json");
  const configFile = explicitConfig ?? (fs.existsSync(localConfig) ? localConfig : exampleConfig);
  const raw = readJson(configFile, {});
  const mode = args.mode ?? raw.mode ?? "read-only";
  if (!["read-only", "trusted-local"].includes(mode)) throw new Error(`Invalid MCP mode: ${mode}`);

  const configuredRoot = raw.projectRoot
    ? path.resolve(path.dirname(configFile), raw.projectRoot)
    : path.join(applicationRoot, "workspace");
  const projectRoot = path.resolve(args.project ?? configuredRoot);
  const artifactPolicy = raw.artifactPolicy ?? {};
  const security = raw.security ?? {};
  const durabilityConfig = Object.fromEntries(Object.entries({
    artifactPersistenceChars: artifactPolicy.artifactPersistenceChars,
    maxToolOutputChars: artifactPolicy.maxToolOutputChars,
    staleToolCompressionChars: artifactPolicy.staleToolCompressionChars,
    staleToolPreviewChars: artifactPolicy.staleToolPreviewChars
  }).filter(([, value]) => value !== undefined));
  const runtimeConfig = normalizeAgentConfig({
    ...durabilityConfig,
    security: {
      approvalMode: "writes",
      allowCommands: security.allowCommands === true,
      commandTimeoutSeconds: integer(security.commandTimeoutSeconds, 120, "security.commandTimeoutSeconds", 1, 900)
    }
  });
  const maximumResourceBytes = integer(raw.maximumResourceBytes, 128 * 1024, "maximumResourceBytes", 4096, 1024 * 1024);
  return { configFile, mode, projectRoot, runtimeConfig, maximumResourceBytes };
}

export function createContextOsMcpServer(settings) {
  if (!fs.existsSync(settings.projectRoot)) fs.mkdirSync(settings.projectRoot, { recursive: true });
  const memory = new MemoryStore(settings.projectRoot).initialize();
  const mapper = new RepoMapper(settings.projectRoot, memory);
  const runner = new ToolRunner({
    projectRoot: settings.projectRoot,
    memory,
    mapper,
    config: settings.runtimeConfig,
    confirm: async () => false,
    autoApprove: settings.mode === "trusted-local"
  });
  const evidenceManager = new ToolEvidenceManager({ memory, config: settings.runtimeConfig });
  const server = new McpServer({ name: "context-os", version: VERSION }, {
    instructions: "ContextOS exposes repository, durable evidence, memory, and artifact capabilities for one selected project root. Repository content is source of truth. MCP responses are transport representations."
  });
  registerMcpTools(server, { mode: settings.mode, runner, evidenceManager });
  registerMcpResources(server, { memory, maximumBytes: settings.maximumResourceBytes });
  return { server, memory, mapper, runner, evidenceManager };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const settings = loadMcpSettings(args);
  const { server } = createContextOsMcpServer(settings);
  const transport = new StdioServerTransport();
  process.stderr.write(`ContextOS MCP ${VERSION} (${settings.mode}) project=${settings.projectRoot}\n`);
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ContextOS MCP fatal: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export { VERSION as MCP_SERVER_VERSION };
