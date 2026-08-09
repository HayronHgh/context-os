const MODEL_MESSAGE_FIELDS = [
  "role",
  "content",
  "name",
  "tool_calls",
  "tool_call_id",
  "reasoning_content"
];

export function serializeMessageForModel(message) {
  return Object.fromEntries(
    MODEL_MESSAGE_FIELDS
      .filter((field) => message[field] !== undefined)
      .map((field) => [field, structuredClone(message[field])])
  );
}

export function serializeContext(messages) {
  return messages.map(serializeMessageForModel);
}
