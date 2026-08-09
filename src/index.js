#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "./agent-runtime.js";
import { LlamaClient } from "./llama-client.js";
import { MemoryStore } from "./memory-store.js";
import { deepMerge, readJson } from "./utils.js";
import { normalizeAgentConfig } from "./config.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(sourceDirectory, "..");

function parseArguments(argv) {
  const result = { yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes") result.yes = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (["--project", "--config", "--prompt"].includes(argument)) result[argument.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function usage() {
  console.log(`ContextOS\n\nUsage:\n  node src/index.js [--project PATH] [--config FILE] [--yes] [--prompt TEXT]\n\nOptions:\n  --project PATH  Coding project root (default: bundled workspace)\n  --config FILE   Override agent JSON config\n  --yes           Auto-approve writes/edits/commands inside the selected project\n  --prompt TEXT   Run one non-interactive turn\n`);
}

function eventPrinter(event) {
  if (event.type === "assistant") console.log(`\nQwen> ${event.content}\n`);
  else if (event.type === "tool_start") process.stdout.write(`  [tool] ${event.name} ... `);
  else if (event.type === "tool_end") console.log(event.denied ? "denied" : event.ok ? "ok" : "failed");
  else if (event.type === "context") {
    const before = (event.initialRatio * 100).toFixed(1);
    const after = (event.finalRatio * 100).toFixed(1);
    console.log(`  [context] ${event.actions.join(", ")} (${before}% -> ${after}%)`);
  }
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
  const projectRoot = path.resolve(args.project ?? path.join(applicationRoot, "workspace"));
  if (!fs.existsSync(projectRoot)) fs.mkdirSync(projectRoot, { recursive: true });
  const memory = new MemoryStore(projectRoot).initialize();
  const client = new LlamaClient(config);
  const terminal = args.prompt ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirm = async (description) => {
    if (args.yes) return true;
    if (!terminal) return false;
    const answer = await terminal.question(`\nApprove ${description}? [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  };
  const runtime = new AgentRuntime({ projectRoot, config, client, memory, confirm, autoApprove: args.yes, onEvent: eventPrinter });

  console.log("ContextOS 0.1.2");
  console.log(`Project: ${projectRoot}`);
  try {
    const status = await runtime.checkHealth();
    console.log(`Server: ready (${status.models.join(", ") || "model loaded"})`);
  } catch (error) {
    console.error(`Server is not ready: ${error.message}`);
    console.error("Run 01_start_server.bat first.");
    if (terminal) terminal.close();
    process.exitCode = 2;
    return;
  }

  if (args.prompt) {
    await runtime.runTurn(args.prompt);
    return;
  }

  console.log("Type /help for commands. Writes and commands ask for approval.\n");
  while (true) {
    let input;
    try {
      input = (await terminal.question("You> ")).trim();
    } catch {
      break;
    }
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      console.log("/health  /map  /state  /memory  /compact  /new  /project  /exit\n");
      continue;
    }
    if (input === "/health") {
      try { console.log(JSON.stringify(await runtime.checkHealth(), null, 2)); } catch (error) { console.error(error.message); }
      continue;
    }
    if (input === "/map") {
      console.log(JSON.stringify(runtime.mapper.build(), null, 2).slice(0, 4000));
      runtime.refreshSystemPrompt();
      continue;
    }
    if (input === "/state") { console.log(JSON.stringify(memory.getState(), null, 2)); continue; }
    if (input === "/memory") { console.log(memory.readProjectMemory()); continue; }
    if (input === "/project") { console.log(projectRoot); continue; }
    if (input === "/new") { runtime.resetConversation(); console.log("Conversation reset; persistent memory retained."); continue; }
    if (input === "/compact") {
      try { console.log(JSON.stringify(await runtime.forceCompact(), null, 2)); } catch (error) { console.error(error.message); }
      continue;
    }
    try {
      await runtime.runTurn(input);
    } catch (error) {
      console.error(`Agent error: ${error.message}\n`);
    }
  }
  terminal.close();
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
