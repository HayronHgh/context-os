#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostContextBridge, hostContextBridgeHealth } from "./host-context-bridge.js";
import { LlamaClient } from "./llama-client.js";
import { StateTransferCompactor } from "./state-transfer-compactor.js";

const VERSION = "0.2.0-dev.7";

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(response, statusCode, body, origin, allowedOrigins) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (origin && allowedOrigins.has(origin)) headers["access-control-allow-origin"] = origin;
  response.writeHead(statusCode, headers);
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      const error = new Error(`request exceeds maximumRequestBytes (${maximumBytes})`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    const wrapped = new Error(`request body is not valid JSON: ${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

export function createHostContextBridgeServer({ bridge, config, agentConfig }) {
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  const maximumBytes = config.maximumRequestBytes ?? 8388608;
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      writeJson(response, 403, { error: "origin is not allowed" }, origin, allowedOrigins);
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...(origin ? { "access-control-allow-origin": origin } : {}),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600"
      });
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, {
        ...hostContextBridgeHealth({ agentConfig, cacheEntries: bridge.cache.size }),
        version: VERSION
      }, origin, allowedOrigins);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/context/prepare") {
      try {
        const body = await readBody(request, maximumBytes);
        const result = await bridge.prepare(body);
        writeJson(response, 200, result, origin, allowedOrigins);
      } catch (error) {
        console.error(`[host-bridge] preparation rejected: ${error.stack ?? error.message}`);
        writeJson(response, error.statusCode ?? 422, { error: error.message, failClosed: true }, origin, allowedOrigins);
      }
      return;
    }
    writeJson(response, 404, { error: "not found" }, origin, allowedOrigins);
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log("ContextOS Host Context Bridge\n\nUsage: node src/host-context-bridge-server.js --config FILE");
    return;
  }
  if (!args.config) throw new Error("--config FILE is required");
  const configPath = path.resolve(args.config);
  const config = readJson(configPath);
  if (config.schemaVersion !== 1) throw new Error("Bridge config schemaVersion must be 1");
  const configDirectory = path.dirname(configPath);
  const agentConfigPath = path.resolve(configDirectory, config.agentConfig ?? "agent.json");
  const agentConfig = readJson(agentConfigPath);
  const client = new LlamaClient(agentConfig);
  const compactor = new StateTransferCompactor({ client });
  const bridge = new HostContextBridge({
    agentConfig,
    compactor,
    cacheEntries: config.cacheEntries ?? 32,
    maximumCacheBytes: config.maximumCacheBytes ?? 33554432
  });
  const server = createHostContextBridgeServer({ bridge, config, agentConfig });
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 8181;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`[host-bridge] ContextOS ${VERSION} listening on http://${host}:${port}`);
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
