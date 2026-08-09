# Security

[繁體中文](SECURITY.zh-TW.md) · English

## Security status

ContextOS is an experimental research MVP. It provides guardrails around model-requested tools, but it is **not a security boundary** and does not provide a strong operating-system sandbox.

## Trust boundaries

### Local model

Model output is untrusted input. Tool names and JSON arguments are parsed and routed by the runtime. The model does not receive direct filesystem APIs from llama-server.

### File tools

File paths first pass lexical project-root containment. Every existing path component is then resolved through the filesystem and checked against the real project root. Reads, writes, and edits reject escapes through symbolic-link files, symbolic-link directories, and Windows junctions; new targets are checked through their nearest existing parent.

This is defense in depth, not a race-free OS sandbox. A hostile process that can replace path components concurrently may still create time-of-check/time-of-use risk.

This containment applies to ContextOS file tools. It does not constrain arbitrary paths embedded in an approved shell command.

### Artifact tool

`read_artifact` accepts a generated artifact ID, not a filesystem path. The store rejects artifact-directory junction escapes, resolves artifact files inside the store, limits each read to 500 lines, and verifies SHA-256 before returning content. These checks detect accidental or simple on-disk tampering; they are not authenticated signatures against an attacker with the user's filesystem authority.

### Shell commands

`run_command` executes through the host shell with the current user's permissions. The runtime:

- asks for approval by default
- applies a timeout
- limits captured output
- rejects a small deny list of common destructive commands

These controls are incomplete. Equivalent destructive actions can be expressed in many ways. Use a VM or container when the repository, prompt, model, or generated command is not trusted.

### Persistent memory

`.qwen-agent/` is plaintext. It may contain:

- proprietary source or snippets
- internal paths and architecture
- command and test output
- environment values printed by tools
- secrets accidentally included in prompts or logs

Do not commit or synchronize it without review.

### Local HTTP server

The example server binds to `127.0.0.1` and limits CORS to localhost. It does not configure an API key or TLS. Do not change the host to `0.0.0.0` or expose the port to a LAN without authentication, TLS, firewall rules, and an explicit threat model.

## Approval modes

Default behavior asks before `write_file`, `edit_file`, and `run_command`.

`--yes` auto-approves those operations for the session. It does not make them safe and must not be used on untrusted repositories.

## Recommended deployment

For important work:

1. Use a dedicated OS account or disposable VM.
2. Keep the model server on localhost.
3. Work from a clean Git branch with frequent reviewable commits.
4. Do not expose production credentials to the agent process.
5. Review every shell command and diff.
6. Back up the repository independently of agent memory.
7. Delete sensitive artifacts and sessions after use.

## Reporting a vulnerability

Do not publish exploit details in a public issue. Use GitHub's private vulnerability reporting for this repository when available, or contact the maintainer through the repository profile.

Please include affected version, operating system, configuration, reproduction steps, impact, and any proposed mitigation.
