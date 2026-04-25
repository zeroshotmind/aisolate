# aisolate

[![npm version](https://img.shields.io/npm/v/aisolate)](https://www.npmjs.com/package/aisolate)
[![npm downloads](https://img.shields.io/npm/dm/aisolate)](https://www.npmjs.com/package/aisolate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Run AI coding agents inside a strict filesystem sandbox. The agent sees only your project folder — nothing else on your machine is visible or accessible.

```
╔══════════════════════════════════════════════╗
║              aisolate  v0.1.0                ║
╚══════════════════════════════════════════════╝

  Project: /Users/you/my-project
  Agent:   Claude Code
  Backend: docker
  Network: allowed
```

## What it does

When you run `aisolate run ./my-project`, the agent (Claude Code by default) is launched inside an isolated environment where:

- `/workspace` is your project — the agent can read and write here
- `/root` is a minimal fake home with just enough config for auth to work
- Everything else — `~/.ssh`, `~/.aws`, other repos, shell history, credentials — **does not exist** from the agent's perspective

After the session ends, aisolate shows you a diff of every file the agent changed. You review and approve (or reject) each change before anything touches your real project.

## Quickstart

```bash
# Install
npm install -g aisolate

# Run Claude Code on a project
aisolate run ./my-project

# Force a specific backend
aisolate run ./my-project --backend docker
aisolate run ./my-project --backend bubblewrap   # Linux
aisolate run ./my-project --backend sandbox-exec  # macOS fallback

# Pass a prompt directly to the agent
aisolate run ./my-project -- "fix the failing tests"

# Disable network access inside the sandbox
aisolate run ./my-project --no-network

# Skip the approval step (apply all changes automatically)
aisolate run ./my-project --no-approval
```

## Requirements

- **Node.js 18+**
- One of the following sandbox backends (auto-detected):

| Backend | Platform | Isolation | How to get it |
|---|---|---|---|
| `bubblewrap` | Linux | Full filesystem namespace | `sudo apt install bubblewrap` |
| `docker` | macOS + Linux | Full container filesystem | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| `sandbox-exec` | macOS | Syscall restriction only | Built into macOS |

Run `aisolate info` to see which backends are available on your machine.

## How it works

```
aisolate run ./my-project
      │
      ▼
1. Workspace setup
   rsync (macOS) or overlayfs (Linux) copies your project into a
   temporary sandbox directory. Your original files are never touched.
      │
      ▼
2. Fake home
   A minimal ~/.claude.json (subscription auth), sanitized .gitconfig,
   and .npmrc are written to a temp home dir. No SSH keys, AWS
   credentials, or tokens are copied in.
      │
      ▼
3. Sandbox launch (auto-selected based on what's available)

   Docker  ──────────────────────────────────────────────────
   docker run --rm -it
     -v /tmp/sandbox/workspace:/workspace
     -v /tmp/sandbox/home:/root
     node:20-slim
   Claude is installed inside the container on first run and
   cached in fakeHome for subsequent runs.
   Default on macOS when Docker Desktop is running.

   bubblewrap  ──────────────────────────────────────────────
   bwrap --bind /tmp/sandbox/workspace /workspace \
         --bind /tmp/sandbox/home /sandbox-home \
         --ro-bind /usr /usr ...
   Unprivileged mount namespace — no root required.
   Default on Linux.

   sandbox-exec  ────────────────────────────────────────────
   macOS Seatbelt profile restricting syscalls. Fallback when
   Docker is not available.
      │
      ▼
4. Agent runs interactively
   Claude Code gets a real PTY (via node-pty or script(1) fallback).
   You interact with it normally inside the sandbox.
      │
      ▼
5. Diff extraction
   After the session ends, aisolate compares the sandbox workspace
   against the original project and collects all changes.
      │
      ▼
6. Approval UI
   Each changed file is shown as a unified diff.
   You accept or reject each one individually.
      │
      ▼
7. Apply
   Accepted changes are written to your real project.
   Rejected changes are discarded with the sandbox.
```

## What is and isn't protected

| The agent cannot see | Why |
|---|---|
| `~/.ssh/` — private keys | Not mounted into sandbox |
| `~/.aws/` — cloud credentials | Not mounted |
| `~/.gnupg/` — GPG keys | Not mounted |
| Other repos on your machine | Outside the workspace mount |
| Shell history, `.zshrc`, `.bashrc` | Not mounted |
| `.env` files outside the project | Outside the workspace |

| The agent can do | Notes |
|---|---|
| Read + write files in the project | That's the whole point |
| Run `npm install`, `go build`, etc. | Network on by default; `--no-network` to block |
| Use your Claude subscription | `~/.claude.json` auth is copied in |
| Use git inside the project | Sanitized `.gitconfig` — no credential helpers |

## Approval workflow

```
  3 files changed

  [1/3] src/main.go  (+12 -4)
  ─────────────────────────────────────
  - old line
  + new line

  Accept this file? (y/n/q/d)
    y = yes    n = no    d = full diff    q = quit (reject remaining)
```

## CLI reference

```
aisolate run <folder> [options] [-- agent-args]

Options:
  -a, --agent <name>     Agent to use: claude (default)
  -b, --backend <type>   Backend: docker | bubblewrap | sandbox-exec | none
  --no-network           Block all outbound network inside the sandbox
  --no-inject            Skip injecting sandbox notice into CLAUDE.md
  --no-approval          Apply all changes without review (dangerous)
  --no-backup            Skip creating .sandbox-backup files before overwriting
  --verbose              Debug output

aisolate info            Show available backends and workspace strategies
aisolate agents          List available agent drivers
aisolate clean <folder>  Remove .sandbox-backup files from a previous run
```

## Adding more agents

aisolate is designed to support any CLI-based coding agent. Implement the `IAgent` interface in `src/agents/` and register it in `src/agents/registry.ts`:

```typescript
export interface IAgent {
  readonly id: string;
  readonly name: string;
  setup(opts: AgentSetupOptions): Promise<AgentSetup>;
  cleanup(workspaceDir: string): Promise<void>;
}
```

Claude Code is the first supported agent. Codex, Aider, and others are planned.

## Development

```bash
git clone https://github.com/zeroshotmind/aisolate
cd aisolate
npm install
npm run build

# Run from source
npm run dev -- run ./my-project

# Rebuild the native PTY module (if node-pty fails on your platform)
npm run rebuild-native
```

## License

MIT
