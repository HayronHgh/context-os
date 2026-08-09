import fs from "node:fs";
import path from "node:path";

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return structuredClone(fallback);
    throw error;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

export function appendJsonLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

export function timestampId(prefix = "item") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${suffix}`;
}

export function deepMerge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base?.[key]) {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function truncateMiddle(text, maximum, marker = "\n...[middle omitted]...\n") {
  const value = String(text ?? "");
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  if (marker.length >= maximum) return marker.slice(0, maximum);
  const remaining = maximum - marker.length;
  const head = Math.ceil(remaining * 0.6);
  return `${value.slice(0, head)}${marker}${value.slice(-(remaining - head))}`;
}

export function isSubpath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // UTF-8 bytes / 3 intentionally overestimates mixed Chinese/code prompts.
  return Math.max(1, Math.ceil(Buffer.byteLength(text ?? "", "utf8") / 3));
}
