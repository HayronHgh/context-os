const DURABILITY_DEFAULTS = {
  artifactPersistenceChars: 800,
  staleToolCompressionChars: 800,
  staleToolPreviewChars: 500,
  maxToolOutputChars: 12000
};

export function normalizeAgentConfig(config = {}) {
  const normalized = { ...DURABILITY_DEFAULTS, ...config };
  for (const field of Object.keys(DURABILITY_DEFAULTS)) {
    const value = normalized[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid agent config: ${field} must be a non-negative integer`);
    }
  }
  if (normalized.artifactPersistenceChars > normalized.staleToolCompressionChars) {
    throw new Error("Invalid agent config: artifactPersistenceChars must be <= staleToolCompressionChars");
  }
  if (normalized.staleToolPreviewChars > normalized.staleToolCompressionChars) {
    throw new Error("Invalid agent config: staleToolPreviewChars must be <= staleToolCompressionChars");
  }
  if (normalized.staleToolCompressionChars > normalized.maxToolOutputChars) {
    throw new Error("Invalid agent config: staleToolCompressionChars must be <= maxToolOutputChars");
  }
  if (normalized.maxToolOutputChars < 256) {
    throw new Error("Invalid agent config: maxToolOutputChars must be at least 256");
  }
  return normalized;
}
