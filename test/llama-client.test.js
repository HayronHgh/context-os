import assert from "node:assert/strict";
import test from "node:test";

import { LlamaClient } from "../src/llama-client.js";

test("planner chat options disable thinking without enabling tools on the wire", async () => {
  const client = new LlamaClient({
    llamaBaseUrl: "http://127.0.0.1:8080",
    model: "qwen3.6-local",
    requestTimeoutSeconds: 30
  });
  let request;
  client.request = async (route, options) => {
    request = { route, options };
    return {
      choices: [{ message: { role: "assistant", content: "{}" } }],
      usage: { prompt_tokens: 8, completion_tokens: 1 }
    };
  };

  await client.chat([{ role: "user", content: "proposal" }], {
    tools: [],
    responseFormat: { type: "json_object" },
    chatTemplateKwargs: { enable_thinking: false }
  });

  const body = JSON.parse(request.options.body);
  assert.equal(request.route, "/v1/chat/completions");
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(body, "tools"), false);
  assert.equal(Object.hasOwn(body, "tool_choice"), false);
});
