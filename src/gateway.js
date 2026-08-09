#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "./agent-runtime.js";
import { createGatewayServer } from "./gateway-server.js";
import { LlamaClient } from "./llama-client.js";
import { MemoryStore } from "./memory-store.js";
import { normalizeAgentConfig } from "./config.js";
import { deepMerge, readJson } from "./utils.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(sourceDirectory, "..");

function parseArguments(argv) {
  const result = { port: 8787 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (["--project", "--config", "--port"].includes(argument)) result[argument.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  result.port = Number(result.port);
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error("--port must be between 1 and 65535");
  return result;
}

function usage() {
  console.log(`ContextOS Web Gateway\n\nUsage:\n  node src/gateway.js [--project PATH] [--config FILE] [--port 8787]\n\nThe gateway always binds to 127.0.0.1.\n`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) return usage();
  const localConfigFile = path.join(applicationRoot, "config", "agent.json");
  const exampleConfigFile = path.join(applicationRoot, "config", "agent.example.json");
  const defaultConfigFile = fs.existsSync(localConfigFile) ? localConfigFile : exampleConfigFile;
  const config = normalizeAgentConfig(deepMerge(
    readJson(defaultConfigFile),
    args.config ? readJson(path.resolve(args.config)) : {}
  ));
  const defaultProjectRoot = path.resolve(args.project ?? path.join(applicationRoot, "workspace"));
  if (!fs.existsSync(defaultProjectRoot)) fs.mkdirSync(defaultProjectRoot, { recursive: true });
  const client = new LlamaClient(config);
  const runtimeFactory = ({ projectRoot, confirm, onEvent }) => new AgentRuntime({
    projectRoot,
    config,
    client,
    memory: new MemoryStore(projectRoot).initialize(),
    confirm,
    onEvent
  });
  const gateway = createGatewayServer({ runtimeFactory, client, defaultProjectRoot });
  const address = await gateway.listen({ port: args.port });
  const url = `http://127.0.0.1:${address.port}`;
  console.log("ContextOS Runtime Chat Gateway");
  console.log(`Web UI: ${url}`);
  console.log(`Default project: ${defaultProjectRoot}`);
  try {
    const health = await client.health();
    console.log(`llama-server: ${health.status ?? "ready"}`);
  } catch (error) {
    console.warn(`llama-server is currently offline: ${error.message}`);
    console.warn("The Web UI will remain available; start 01_start_server.bat before creating a session.");
  }
  const shutdown = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
