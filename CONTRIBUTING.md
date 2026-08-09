# Contributing

[繁體中文](CONTRIBUTING.zh-TW.md) · English

ContextOS is an experimental project. Focused changes with tests and clear evidence are preferred over broad feature additions.

## Development

```powershell
git clone https://github.com/HayronHgh/context-os.git
cd context-os
node --test
```

No dependency installation is required for the current runtime.

## Pull requests

1. Keep each PR focused on one problem.
2. Explain the user impact and design trade-offs.
3. Add or update tests.
4. Update both English and Traditional Chinese docs when behavior changes.
5. Do not commit local configs, `.qwen-agent`, logs, model files, or secrets.
6. Call out security implications for tool, command, path, or memory changes.

## Project priorities

- measurable context recovery quality
- correctness and recoverability
- auditability
- small dependency surface
- explicit security boundaries

Large additions such as embeddings, multi-agent orchestration, or a UI should include a concrete use case and avoid weakening the core context-lifecycle hypothesis.
