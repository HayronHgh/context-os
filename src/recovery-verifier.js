import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONTEXT_UNIT_RECOVERABILITY } from "./context-unit.js";
import { isSubpath } from "./utils.js";

export const RECOVERY_PROOF_SCHEMA_VERSION = 1;

export const RECOVERY_PROOF_STATUSES = Object.freeze([
  "VERIFIED",
  "NOT_REQUIRED",
  "FAILED"
]);

export const RECOVERY_FAILURE_CODES = Object.freeze([
  "RECOVERY_REFERENCE_MISSING",
  "RECOVERY_PROVIDER_UNAVAILABLE",
  "RECOVERY_SOURCE_NOT_FOUND",
  "RECOVERY_SOURCE_INVALID",
  "RECOVERY_INTEGRITY_MISMATCH",
  "RECOVERY_VERIFICATION_FAILED"
]);

const DESTRUCTIVE_ACTIONS = new Set(["COMPRESS", "EXTERNALIZE", "EVICT"]);
const FAILURE_CODES = new Set(RECOVERY_FAILURE_CODES);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function detail(value) {
  return String(value ?? "Recovery verification failed").slice(0, 500);
}

function referenceIsUsable(type, reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  if (type === "artifact") return typeof reference.artifactId === "string" && reference.artifactId.length > 0;
  if (type === "repository") return typeof reference.path === "string" && reference.path.length > 0;
  if (type === "memory") return Object.keys(reference).length > 0;
  if (type === "rebuildable") return typeof reference.mechanism === "string" && reference.mechanism.length > 0;
  return false;
}

export function recoveryProofRequired(unit, action) {
  return DESTRUCTIVE_ACTIONS.has(action) && unit?.recoverability !== "none";
}

function proofBase({ unit, action, checkedAt }) {
  return {
    schemaVersion: RECOVERY_PROOF_SCHEMA_VERSION,
    unitId: unit?.id ?? null,
    action,
    sourceType: unit?.recoverability ?? null,
    checkedAt
  };
}

function failedProof(input, code, message) {
  return deepFreeze({
    ...proofBase(input),
    status: "FAILED",
    code: FAILURE_CODES.has(code) ? code : "RECOVERY_VERIFICATION_FAILED",
    detail: detail(message),
    evidence: null
  });
}

export class RecoveryVerifier {
  constructor({ providers = {}, now = () => new Date() } = {}) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error("RecoveryVerifier providers must be an object");
    }
    if (typeof now !== "function") throw new Error("RecoveryVerifier now must be a function");
    this.providers = { ...providers };
    this.now = now;
  }

  async verify({ unit, action } = {}) {
    const checkedAt = this.now().toISOString();
    const input = { unit, action, checkedAt };
    if (!unit || typeof unit !== "object" || !CONTEXT_UNIT_RECOVERABILITY.includes(unit.recoverability)) {
      return failedProof(input, "RECOVERY_SOURCE_INVALID", "Context Unit has no valid recoverability classification");
    }
    if (!recoveryProofRequired(unit, action)) {
      return deepFreeze({
        ...proofBase(input),
        status: "NOT_REQUIRED",
        code: null,
        detail: unit.recoverability === "none"
          ? "No Runtime recovery claim is attached to this action"
          : "Action does not require execution-time recovery proof",
        evidence: null
      });
    }
    if (!referenceIsUsable(unit.recoverability, unit.recoveryRef)) {
      return failedProof(input, "RECOVERY_REFERENCE_MISSING", `${unit.recoverability} recovery reference is missing or incomplete`);
    }
    const provider = this.providers[unit.recoverability];
    if (typeof provider !== "function") {
      return failedProof(input, "RECOVERY_PROVIDER_UNAVAILABLE", `No ${unit.recoverability} recovery provider is available`);
    }

    try {
      const result = await provider({
        unit: structuredClone(unit),
        action,
        recoveryRef: structuredClone(unit.recoveryRef)
      });
      if (result?.verified !== true) {
        return failedProof(input, result?.code, result?.detail);
      }
      const evidence = result.evidence == null ? {} : structuredClone(result.evidence);
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        return failedProof(input, "RECOVERY_SOURCE_INVALID", "Recovery provider returned invalid evidence");
      }
      return deepFreeze({
        ...proofBase(input),
        status: "VERIFIED",
        code: null,
        detail: null,
        evidence
      });
    } catch (error) {
      return failedProof(input, "RECOVERY_VERIFICATION_FAILED", error?.message ?? error);
    }
  }
}

function providerFailure(code, message) {
  return { verified: false, code, detail: message };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createArtifactRecoveryProvider(memory) {
  if (!memory || typeof memory.readArtifact !== "function") {
    throw new Error("Artifact recovery provider requires memory.readArtifact()");
  }
  return async ({ recoveryRef }) => {
    const artifactIds = [...new Set([
      recoveryRef.artifactId,
      ...(Array.isArray(recoveryRef.artifactIds) ? recoveryRef.artifactIds : [])
    ])];
    const artifacts = [];
    try {
      for (const artifactId of artifactIds) {
        const artifact = memory.readArtifact(artifactId, { startLine: 1, endLine: 1 });
        artifacts.push({
          artifactId,
          sha256: artifact.metadata.sha256 ?? null,
          bytes: artifact.metadata.bytes ?? null
        });
      }
    } catch (error) {
      const code = /integrity/i.test(String(error?.message))
        ? "RECOVERY_INTEGRITY_MISMATCH"
        : "RECOVERY_SOURCE_NOT_FOUND";
      return providerFailure(code, error?.message ?? error);
    }
    const expected = String(recoveryRef.sha256 ?? "").replace(/^sha256:/, "");
    if (expected && artifacts[0]?.sha256 !== expected) {
      return providerFailure("RECOVERY_INTEGRITY_MISMATCH", "Artifact recovery reference SHA-256 does not match current artifact metadata");
    }
    return { verified: true, evidence: { artifacts } };
  };
}

export function createRepositoryRecoveryProvider(projectRoot) {
  const root = path.resolve(projectRoot);
  return async ({ recoveryRef }) => {
    if (path.isAbsolute(recoveryRef.path)) {
      return providerFailure("RECOVERY_SOURCE_INVALID", "Repository recovery path must be project-relative");
    }
    const candidate = path.resolve(root, recoveryRef.path);
    if (!isSubpath(root, candidate)) {
      return providerFailure("RECOVERY_SOURCE_INVALID", "Repository recovery path escapes the project root");
    }
    try {
      const realRoot = fs.realpathSync.native(root);
      const realFile = fs.realpathSync.native(candidate);
      if (!isSubpath(realRoot, realFile) || !fs.statSync(realFile).isFile()) {
        return providerFailure("RECOVERY_SOURCE_INVALID", "Repository recovery source is not a file inside the project root");
      }
      const content = fs.readFileSync(realFile);
      const actual = sha256(content);
      const expected = String(recoveryRef.sha256 ?? "").replace(/^sha256:/, "");
      if (expected && expected !== actual) {
        return providerFailure("RECOVERY_INTEGRITY_MISMATCH", "Repository recovery source SHA-256 changed");
      }
      return {
        verified: true,
        evidence: {
          path: path.relative(realRoot, realFile).replaceAll("\\", "/"),
          sha256: actual,
          bytes: content.length
        }
      };
    } catch (error) {
      return providerFailure("RECOVERY_SOURCE_NOT_FOUND", error?.message ?? error);
    }
  };
}

export function createMemoryRecoveryProvider(memory) {
  if (!memory || typeof memory.getState !== "function" || typeof memory.listEpisodes !== "function") {
    throw new Error("Memory recovery provider requires getState() and listEpisodes()");
  }
  return async ({ recoveryRef }) => {
    if (typeof recoveryRef.stateKey === "string") {
      const state = memory.getState();
      if (!Object.hasOwn(state, recoveryRef.stateKey) || state[recoveryRef.stateKey] == null) {
        return providerFailure("RECOVERY_SOURCE_NOT_FOUND", `Memory state key is unavailable: ${recoveryRef.stateKey}`);
      }
      return { verified: true, evidence: { stateKey: recoveryRef.stateKey } };
    }
    if (typeof recoveryRef.episodeId === "string") {
      const exists = memory.listEpisodes(Number.MAX_SAFE_INTEGER)
        .some((episode) => episode.id === recoveryRef.episodeId);
      if (!exists) return providerFailure("RECOVERY_SOURCE_NOT_FOUND", `Memory episode is unavailable: ${recoveryRef.episodeId}`);
      return { verified: true, evidence: { episodeId: recoveryRef.episodeId } };
    }
    return providerFailure("RECOVERY_SOURCE_INVALID", "Memory recovery reference must name stateKey or episodeId");
  };
}

export function createRebuildableRecoveryProvider(registry) {
  return async ({ recoveryRef }) => {
    const mechanism = recoveryRef.mechanism;
    const available = registry instanceof Map
      ? typeof registry.get(mechanism) === "function"
      : registry instanceof Set
        ? registry.has(mechanism)
        : typeof registry?.[mechanism] === "function";
    if (!available) {
      return providerFailure("RECOVERY_SOURCE_NOT_FOUND", `Rebuild mechanism is unavailable: ${mechanism}`);
    }
    return { verified: true, evidence: { mechanism } };
  };
}
