import fs from "node:fs";
import path from "node:path";
import { appendJsonLine, ensureDir, readJson, timestampId, writeJsonAtomic } from "./utils.js";

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
    for (const directory of [this.root, this.episodesDir, this.artifactsDir, this.sessionsDir]) ensureDir(directory);
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
    const id = timestampId(kind);
    const file = path.join(this.artifactsDir, `${id}.txt`);
    fs.writeFileSync(file, String(content), "utf8");
    writeJsonAtomic(path.join(this.artifactsDir, `${id}.json`), {
      id,
      createdAt: new Date().toISOString(),
      file: path.relative(this.projectRoot, file),
      ...metadata
    });
    return { id, file };
  }

  saveEpisode(episode) {
    const id = timestampId("episode");
    const value = { id, createdAt: new Date().toISOString(), ...episode };
    writeJsonAtomic(path.join(this.episodesDir, `${id}.json`), value);
    return value;
  }

  listEpisodes(limit = 8) {
    return fs.readdirSync(this.episodesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(-limit)
      .reverse()
      .map((name) => readJson(path.join(this.episodesDir, name)))
      .filter(Boolean);
  }

  readRepoMap() {
    return readJson(this.repoMapFile, { generatedAt: null, files: [] });
  }

  writeRepoMap(value) {
    writeJsonAtomic(this.repoMapFile, value);
    return value;
  }
}
