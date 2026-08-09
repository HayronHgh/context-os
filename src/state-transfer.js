const STRING_FIELDS = ["objective", "currentState"];
const STRING_ARRAY_FIELDS = [
  "userRequirements",
  "constraints",
  "architecture",
  "decisions",
  "modifiedFiles",
  "investigatedFiles",
  "tests",
  "errors",
  "rejectedApproaches",
  "artifacts",
  "nextActions"
];

export const STATE_TRANSFER_FIELDS = [...STRING_FIELDS, ...STRING_ARRAY_FIELDS];

export function parseStateTransfer(text) {
  let value;
  try {
    value = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new Error(`State transfer is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("State transfer must be one JSON object");
  }

  const errors = [];
  for (const field of STRING_FIELDS) {
    if (typeof value[field] !== "string") errors.push(`${field} must be a string`);
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string")) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  const unexpected = Object.keys(value).filter((field) => !STATE_TRANSFER_FIELDS.includes(field));
  if (unexpected.length) errors.push(`unexpected fields: ${unexpected.join(", ")}`);
  if (errors.length) throw new Error(`State transfer schema validation failed: ${errors.join("; ")}`);

  return Object.fromEntries(STATE_TRANSFER_FIELDS.map((field) => [field, value[field]]));
}

export function formatStateTransfer(value) {
  return JSON.stringify(value, null, 2);
}
