#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const uiRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/patch-llama-ui.mjs PATH_TO_LLAMA_CPP_TOOLS_UI");

const chatService = path.join(uiRoot, "src", "lib", "services", "chat.service.ts");
const overlaySource = path.join(projectRoot, "ui-overlay", "contextos-bridge.service.ts");
const overlayTarget = path.join(uiRoot, "src", "lib", "services", "contextos-bridge.service.ts");
const staticDirectory = path.join(uiRoot, "static");
if (!fs.existsSync(chatService) || !fs.existsSync(path.join(uiRoot, "svelte.config.js"))) {
  throw new Error(`Not a llama.cpp tools/ui source directory: ${uiRoot}`);
}

fs.copyFileSync(overlaySource, overlayTarget);
let source = fs.readFileSync(chatService, "utf8").replace(/\r\n/g, "\n");
const importLine = "import { ContextOsBridgeService } from './contextos-bridge.service';";
if (!source.includes(importLine)) {
  const anchor = "import { streamIdentity } from '$lib/utils/stream-identity';";
  if (!source.includes(anchor)) throw new Error("llama.cpp ChatService import anchor changed; refusing a fuzzy patch");
  source = source.replace(anchor, `${anchor}\n${importLine}`);
}

const integrationMarker = "ContextOsBridgeService.prepare(requestBody, conversationId, signal)";
if (!source.includes(integrationMarker)) {
  const anchor = "\n\t\ttry {\n\t\t\tconst headers: Record<string, string> = { ...getJsonHeaders() };";
  if (!source.includes(anchor)) throw new Error("llama.cpp ChatService request anchor changed; refusing a fuzzy patch");
  const integration = `

		if (conversationId) {
			const prepared = await ContextOsBridgeService.prepare(requestBody, conversationId, signal);
			requestBody.messages = prepared.messages;
			if (prepared.status === 'PREPARED') {
				console.info(
					\`[ContextOS] prepared request: \${prepared.report.initialTokens} -> \${prepared.report.finalTokens} estimated tokens (\${prepared.report.actions.join(', ')})\`
				);
			}
		}`;
  source = source.replace(anchor, `${integration}${anchor}`);
}
fs.writeFileSync(chatService, source, "utf8");
fs.mkdirSync(staticDirectory, { recursive: true });
fs.writeFileSync(path.join(staticDirectory, "contextos-host-bridge.json"), `${JSON.stringify({
  schemaVersion: 1,
  integration: "context-os-host-bridge",
  llamaCppTag: "b10295"
}, null, 2)}\n`, "utf8");
console.log(`Patched llama.cpp Web UI at ${uiRoot}`);
