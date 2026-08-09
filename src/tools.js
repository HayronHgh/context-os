import fs from "node:fs";
import path from "node:path";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { isSubpath } from "./utils.js";

const exec = promisify(execCallback);
const SKIP_DIRECTORIES = new Set([".git", ".qwen-agent", "node_modules", "dist", "build", "target", "models"]);

const definition = (name, description, properties, required = []) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false }
  }
});

export const TOOL_DEFINITIONS = [
  definition("read_file", "Read a UTF-8 text file inside the active project.", {
    path: { type: "string", description: "Path relative to project root" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  }, ["path"]),
  definition("file_glob_search", "List project files matching a glob such as src/**/*.js.", {
    pattern: { type: "string" },
    maxResults: { type: "integer", minimum: 1, maximum: 500 }
  }, ["pattern"]),
  definition("grep_search", "Search text or a regular expression in project files.", {
    query: { type: "string" },
    path: { type: "string" },
    regex: { type: "boolean" },
    caseSensitive: { type: "boolean" },
    maxResults: { type: "integer", minimum: 1, maximum: 500 }
  }, ["query"]),
  definition("write_file", "Create or overwrite a UTF-8 file inside the project. Requires approval.", {
    path: { type: "string" },
    content: { type: "string" }
  }, ["path", "content"]),
  definition("edit_file", "Replace exact text in a project file. Requires approval.", {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
    replaceAll: { type: "boolean" }
  }, ["path", "oldText", "newText"]),
  definition("run_command", "Run a command in the project root and return stdout/stderr. Requires approval.", {
    command: { type: "string" },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 }
  }, ["command"]),
  definition("build_repo_map", "Scan the project and persist a compact file/symbol map.", {}),
  definition("read_working_state", "Read persistent task state, project memory, recent episodes, and artifact recovery metadata.", {}),
  definition("read_artifact", "Read a bounded line range from durable tool evidence by artifact ID.", {
    artifactId: { type: "string", description: "Artifact ID returned by a previous tool result" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  }, ["artifactId"]),
  definition("update_working_state", "Persist compact state needed to continue the coding task after context compaction.", {
    objective: { type: "string" },
    currentTask: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    activeFiles: { type: "array", items: { type: "string" } },
    knownFailures: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  }),
  definition("save_episode", "Save a solved problem as reusable episodic memory.", {
    task: { type: "string" },
    symptoms: { type: "array", items: { type: "string" } },
    rootCause: { type: "string" },
    solution: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    result: { type: "string" }
  }, ["task", "solution"]),
  definition("get_datetime", "Get the current local and UTC date/time.", {})
];

function globToRegExp(glob) {
  let source = "";
  const normalized = glob.replaceAll("\\", "/");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

export class ToolRunner {
  constructor({ projectRoot, memory, mapper, config, confirm, autoApprove = false }) {
    this.projectRoot = path.resolve(projectRoot);
    this.realProjectRoot = fs.realpathSync.native(this.projectRoot);
    this.memory = memory;
    this.mapper = mapper;
    this.config = config;
    this.confirm = confirm;
    this.autoApprove = autoApprove;
  }

  resolveProjectPath(relative = ".") {
    const candidate = path.resolve(this.projectRoot, relative);
    if (!isSubpath(this.projectRoot, candidate)) throw new Error(`Path escapes project root: ${relative}`);
    const pathWithinRoot = path.relative(this.projectRoot, candidate);
    let current = this.projectRoot;
    for (const segment of pathWithinRoot.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        fs.lstatSync(current);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      let real;
      try {
        real = fs.realpathSync.native(current);
      } catch (error) {
        throw new Error(`Path contains an invalid symbolic link: ${relative} (${error.message})`);
      }
      if (!isSubpath(this.realProjectRoot, real)) {
        throw new Error(`Path escapes project root through a symbolic link or junction: ${relative}`);
      }
    }
    return candidate;
  }

  isMutation(name) {
    return ["write_file", "edit_file", "run_command"].includes(name);
  }

  describeMutation(name, args) {
    if (name === "run_command") return `run command: ${args.command}`;
    return `${name}: ${args.path}`;
  }

  async approve(name, args) {
    if (!this.isMutation(name)) return true;
    if (this.autoApprove || this.config.security.approvalMode === "never") return true;
    return this.confirm(this.describeMutation(name, args));
  }

  walk(relative = ".", maximum = 5000) {
    const start = this.resolveProjectPath(relative);
    const output = [];
    const stack = [start];
    while (stack.length && output.length < maximum) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(absolute);
        } else if (entry.isFile()) {
          output.push(path.relative(this.projectRoot, absolute).replaceAll("\\", "/"));
        }
        if (output.length >= maximum) break;
      }
    }
    return output;
  }

  async execute(name, args = {}) {
    if (!(await this.approve(name, args))) return { ok: false, denied: true, message: "User denied this tool call." };
    switch (name) {
      case "read_file": return this.readFile(args);
      case "file_glob_search": return this.fileGlob(args);
      case "grep_search": return this.grep(args);
      case "write_file": return this.writeFile(args);
      case "edit_file": return this.editFile(args);
      case "run_command": return this.runCommand(args);
      case "build_repo_map": return this.buildRepoMap();
      case "read_working_state": return this.readWorkingState();
      case "read_artifact": return this.memory.readArtifact(args.artifactId, args);
      case "update_working_state": return this.memory.updateState(args);
      case "save_episode": return this.memory.saveEpisode(args);
      case "get_datetime": return { local: new Date().toString(), utc: new Date().toISOString() };
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  readFile({ path: relative, startLine = 1, endLine = 2000 }) {
    const file = this.resolveProjectPath(relative);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, Math.max(start, endLine));
    return {
      path: path.relative(this.projectRoot, file).replaceAll("\\", "/"),
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")
    };
  }

  fileGlob({ pattern, maxResults = 200 }) {
    const regex = globToRegExp(pattern);
    const matches = this.walk(".").filter((file) => regex.test(file)).slice(0, maxResults);
    return { pattern, count: matches.length, matches };
  }

  grep({ query, path: relative = ".", regex = false, caseSensitive = false, maxResults = 100 }) {
    const flags = caseSensitive ? "g" : "gi";
    const pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const files = this.walk(relative);
    const matches = [];
    for (const file of files) {
      let text;
      try {
        const absolute = this.resolveProjectPath(file);
        if (fs.statSync(absolute).size > 2 * 1024 * 1024) continue;
        text = fs.readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) matches.push({ file, line: index + 1, text: line.slice(0, 500) });
        if (matches.length >= maxResults) return { query, count: matches.length, truncated: true, matches };
      }
    }
    return { query, count: matches.length, truncated: false, matches };
  }

  writeFile({ path: relative, content }) {
    const file = this.resolveProjectPath(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    return { ok: true, path: path.relative(this.projectRoot, file).replaceAll("\\", "/"), bytes: Buffer.byteLength(content) };
  }

  editFile({ path: relative, oldText, newText, replaceAll = false }) {
    const file = this.resolveProjectPath(relative);
    const before = fs.readFileSync(file, "utf8");
    const occurrences = before.split(oldText).length - 1;
    if (!occurrences) throw new Error(`oldText was not found in ${relative}`);
    if (occurrences > 1 && !replaceAll) throw new Error(`oldText occurs ${occurrences} times; set replaceAll or provide more context`);
    const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
    fs.writeFileSync(file, after, "utf8");
    return { ok: true, path: relative, replacements: replaceAll ? occurrences : 1 };
  }

  async runCommand({ command, timeoutSeconds }) {
    if (!this.config.security.allowCommands) throw new Error("run_command is disabled in config/agent.json");
    const forbidden = /\b(?:rm|rmdir|del|erase|format|diskpart|shutdown|remove-item)\b|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/i;
    if (forbidden.test(command)) throw new Error("Destructive command denied by runtime policy");
    const timeout = Math.min(timeoutSeconds ?? this.config.security.commandTimeoutSeconds, 900) * 1000;
    try {
      const result = await exec(command, {
        cwd: this.projectRoot,
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        shell: process.env.ComSpec ?? "cmd.exe"
      });
      return { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return {
        ok: false,
        exitCode: typeof error.code === "number" ? error.code : null,
        killed: Boolean(error.killed),
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message
      };
    }
  }

  buildRepoMap() {
    const map = this.mapper.build();
    return { generatedAt: map.generatedAt, fileCount: map.fileCount, skipped: map.skipped, truncated: map.truncated };
  }

  readWorkingState() {
    return {
      state: this.memory.getState(),
      projectMemory: this.memory.readProjectMemory(),
      recentEpisodes: this.memory.listEpisodes(8),
      recentArtifacts: this.memory.listArtifacts(12)
    };
  }
}
