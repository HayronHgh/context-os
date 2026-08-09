import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appendJsonLine, ensureDir, isSubpath, readJson, timestampId, writeJsonAtomic } from "./utils.js";

const EMPTY_STATE = {
  objective: "",
  currentTask: "",
  constraints: [],
  activeFiles: [],
  knownFailures: [],
  decisions: [],
  nextActions: [],
  notes: [],
  stateTransfer: "",
  updatedAt: null
};

export class MemoryStore {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.root = path.join(this.projectRoot, ".qwen-agent");
    this.stateFile = path.join(this.root, "state.json");
    this.projectFile = path.join(this.root, "project.md");
    this.episodesDir = path.join(this.root, "episodes");
    this.artifactsDir = path.join(this.root, "artifacts");
    this.sessionsDir = path.join(this.root, "sessions");
    this.repoMapFile = path.join(this.root, "repo-map.json");
    this.sessionId = timestampId("session");
    this.sessionFile = path.join(this.sessionsDir, `${this.sessionId}.jsonl`);
  }

  initialize() {
    ensureDir(this.projectRoot);
    this.realProjectRoot = fs.realpathSync.native(this.projectRoot);
    for (const directory of [this.root, this.episodesDir, this.artifactsDir, this.sessionsDir]) {
      ensureDir(directory);
      const real = fs.realpathSync.native(directory);
      if (!isSubpath(this.realProjectRoot, real)) throw new Error(`Memory directory escapes project root: ${directory}`);
    }
    if (!fs.existsSync(this.stateFile)) writeJsonAtomic(this.stateFile, EMPTY_STATE);
    if (!fs.existsSync(this.projectFile)) {
      fs.writeFileSync(this.projectFile, "# Project memory\n\nDescribe architecture, conventions, entry points, and non-negotiable constraints here.\n", "utf8");
    }
    return this;
  }

  getState() {
    return readJson(this.stateFile, EMPTY_STATE);
  }

  updateState(patch) {
    const current = this.getState();
    const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => key in EMPTY_STATE));
    const next = { ...current, ...allowed, updatedAt: new Date().toISOString() };
    writeJsonAtomic(this.stateFile, next);
    return next;
  }

  readProjectMemory() {
    return fs.readFileSync(this.projectFile, "utf8");
  }

  appendSession(event) {
    appendJsonLine(this.sessionFile, { timestamp: new Date().toISOString(), ...event });
  }

  saveArtifact(content, kind = "tool", metadata = {}) {
    this.assertArtifactsDirectory();
    const id = timestampId(kind);
    const file = path.join(this.artifactsDir, `${id}.txt`);
    const text = String(content);
    const bytes = Buffer.byteLength(text, "utf8");
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
    const value = {
      ...metadata,
      id,
      createdAt: new Date().toISOString(),
      file: path.relative(this.projectRoot, file).replaceAll("\\", "/"),
      chars: text.length,
      bytes,
      sha256
    };
    writeJsonAtomic(path.join(this.artifactsDir, `${id}.json`), value);
    return value;
  }

  readArtifact(artifactId, { startLine = 1, endLine = startLine + 299 } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(String(artifactId ?? ""))) {
      throw new Error(`Invalid artifact ID: ${artifactId}`);
    }
    this.assertArtifactsDirectory();
    const metadataFile = this.resolveArtifactFile(`${artifactId}.json`);
    const contentFile = this.resolveArtifactFile(`${artifactId}.txt`);
    const metadata = readJson(metadataFile);
    if (!metadata || metadata.id !== artifactId) throw new Error(`Invalid artifact metadata: ${artifactId}`);
    const fullText = fs.readFileSync(contentFile, "utf8");
    const sha256 = createHash("sha256").update(fullText, "utf8").digest("hex");
    if (metadata.sha256 && metadata.sha256 !== sha256) throw new Error(`Artifact integrity check failed: ${artifactId}`);
    const lines = fullText.split(/\r?\n/);
    const start = Math.max(1, Number.isInteger(startLine) ? startLine : 1);
    const requestedEnd = Math.max(start, Number.isInteger(endLine) ? endLine : start + 299);
    const end = Math.min(lines.length, requestedEnd, start + 499);
    return {
      artifactId,
      metadata,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: start > lines.length ? "" : lines.slice(start - 1, end).join("\n")
    };
  }

  listArtifacts(limit = 12) {
    if (limit <= 0) return [];
    this.assertArtifactsDirectory();
    const names = fs.readdirSync(this.artifactsDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const artifacts = [];
    for (const name of names) {
      try {
        const artifact = readJson(this.resolveArtifactFile(name));
        if (artifact?.id) artifacts.push(artifact);
      } catch {
        // Auxiliary corruption must not hide unrelated valid artifacts.
      }
      if (artifacts.length >= limit) break;
    }
    return artifacts;
  }

  assertArtifactsDirectory() {
    const real = fs.realpathSync.native(this.artifactsDir);
    if (!isSubpath(this.realProjectRoot, real)) throw new Error("Artifact directory escapes project root");
    return real;
  }

  resolveArtifactFile(name) {
    const realDirectory = this.assertArtifactsDirectory();
    const candidate = path.join(this.artifactsDir, name);
    const real = fs.realpathSync.native(candidate);
    if (!isSubpath(realDirectory, real)) throw new Error(`Artifact file escapes artifact storage: ${name}`);
    return real;
  }

  saveEpisode(episode) {
    const id = timestampId("episode");
    const value = { id, createdAt: new Date().toISOString(), ...episode };
    writeJsonAtomic(path.join(this.episodesDir, `${id}.json`), value);
    return value;
  }

  listEpisodes(limit = 8) {
    if (limit <= 0) return [];
    const names = fs.readdirSync(this.episodesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const episodes = [];
    for (const name of names) {
      try {
        const episode = readJson(path.join(this.episodesDir, name));
        if (episode) episodes.push(episode);
      } catch {
        // Auxiliary corruption must not hide unrelated valid episodes.
      }
      if (episodes.length >= limit) break;
    }
    return episodes;
  }

  readRepoMap() {
    try {
      return readJson(this.repoMapFile, { generatedAt: null, files: [] });
    } catch {
      return { generatedAt: null, files: [], recoveredFromCorruption: true };
    }
  }

  writeRepoMap(value) {
    writeJsonAtomic(this.repoMapFile, value);
    return value;
  }
}
