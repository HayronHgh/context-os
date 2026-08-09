import fs from "node:fs";
import path from "node:path";

const IGNORED = new Set([
  ".git", ".hg", ".svn", ".qwen-agent", "node_modules", "dist", "build", "coverage",
  "target", ".venv", "venv", "__pycache__", ".next", ".cache", "models"
]);

const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".kt",
  ".cs", ".cpp", ".c", ".h", ".hpp", ".rb", ".php", ".swift", ".vue", ".svelte", ".md",
  ".json", ".yaml", ".yml", ".toml", ".sql", ".ps1", ".sh", ".bat"
]);

function extractSymbols(text, extension) {
  const patterns = extension === ".py"
    ? [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm]
    : extension === ".rs"
      ? [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm]
      : [/\b(?:class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g];
  const symbols = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!symbols.includes(match[1])) symbols.push(match[1]);
      if (symbols.length >= 40) return symbols;
    }
  }
  return symbols;
}

export class RepoMapper {
  constructor(projectRoot, memory) {
    this.projectRoot = path.resolve(projectRoot);
    this.memory = memory;
  }

  build({ maxFiles = 3000, maxFileBytes = 512 * 1024 } = {}) {
    const files = [];
    const stack = [this.projectRoot];
    let skipped = 0;
    while (stack.length && files.length < maxFiles) {
      const directory = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        skipped += 1;
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED.has(entry.name)) stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const stats = fs.statSync(absolute);
        const relative = path.relative(this.projectRoot, absolute).replaceAll("\\", "/");
        const extension = path.extname(entry.name).toLowerCase();
        const item = { path: relative, bytes: stats.size, extension, symbols: [] };
        if (SOURCE_EXTENSIONS.has(extension) && stats.size <= maxFileBytes) {
          try {
            item.symbols = extractSymbols(fs.readFileSync(absolute, "utf8"), extension);
          } catch {
            skipped += 1;
          }
        }
        files.push(item);
        if (files.length >= maxFiles) break;
      }
    }
    const map = {
      projectRoot: this.projectRoot,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      truncated: stack.length > 0,
      skipped,
      files
    };
    this.memory.writeRepoMap(map);
    return map;
  }

  summarize(map = this.memory.readRepoMap(), maximumCharacters = 12000) {
    if (!map.generatedAt) return "Repository map has not been generated. Use build_repo_map.";
    const lines = [`Repository map (${map.fileCount} files, generated ${map.generatedAt}):`];
    for (const file of map.files) {
      const symbols = file.symbols?.length ? ` :: ${file.symbols.join(", ")}` : "";
      const line = `${file.path}${symbols}`;
      if (lines.join("\n").length + line.length > maximumCharacters) {
        lines.push(`... ${map.fileCount - lines.length + 1} more files omitted`);
        break;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }
}
