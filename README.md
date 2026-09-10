# pi-gvs-lite

A deliberately small Pi Coding Agent extension inspired by four useful ideas from GVS5H:

1. Automatic verifier loop after workspace changes.
2. Stuck guard for repeated verifier failures.
3. Persistent compact task ledger in `.pi/work/`.
4. Replace-and-curate notes with hard size limits instead of append-only memory.

It does not add manager/worker agents, provider routing, benchmark scaffolding, or a second model.

## What it does

For trusted projects, gvs-lite creates:

```text
.pi/work/
  goal.md
  plan.md
  findings.md
  status.json
```

The current ledger is injected into Pi's system prompt for each task. `plan.md` and `findings.md` are expected to be rewritten as current state rather than used as logs. Hard limits prevent them from growing without bound.

After code changes, gvs-lite runs project verification. It auto-detects common stacks:

- Node.js / TypeScript: typecheck, lint and test scripts from `package.json`.
- Rust: `cargo test --quiet`.
- Go: `go test ./...`.
- Python: Ruff, mypy and/or pytest when the project indicates they are in use.
- Gradle / Maven.
- Makefile `test` or `check` targets.
- Terraform: `terraform validate` for root-level `.tf` projects.

A failing verifier is fed back to Pi as a new task. If the same normalized failure repeats twice, Pi is explicitly told to stop repeating the same approach and re-analyze the root cause. Automatic repair stops after three failed verifier runs by default.

## Install

From npm once published:

```bash
pi install npm:pi-gvs-lite
```

Or directly from GitHub:

```bash
pi install git:github.com/bruvv/pi-gvs-lite
```

For local development:

```bash
./install.sh
```

Pi packages can also be installed project-locally with `-l` if desired.

## Commands

```text
/gvs-status
/gvs-verify
/gvs-reset optional new goal
```

## Configuration

Configuration is optional. Copy the example if you want overrides:

```bash
mkdir -p .pi
cp /path/to/pi-gvs-lite/example/gvs-lite.json .pi/gvs-lite.json
```

The most useful override is an explicit verifier:

```json
{
  "verify": {
    "commands": [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test"
    ]
  }
}
```

Setting `commands` to `null` enables auto-detection.

## Defaults

```json
{
  "enabled": true,
  "verify": {
    "commands": null,
    "timeoutMs": 120000,
    "maxAutoRetries": 3,
    "outputMaxChars": 12000
  },
  "ledger": {
    "goalMaxChars": 6000,
    "planMaxChars": 4000,
    "findingsMaxChars": 8000
  },
  "stuck": {
    "sameFailureThreshold": 2,
    "hardStopThreshold": 3
  }
}
```

## Safety

Auto-verification only runs when Pi reports the project as trusted. This matters because test/lint scripts are project code and therefore can execute arbitrary commands.

`.pi/work/` changes are excluded from the Git workspace fingerprint, so maintaining the ledger does not recursively trigger verification.
