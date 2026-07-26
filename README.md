# Claude Desktop Codex Broker

Delegate coding tasks from Claude (Cowork / Claude Desktop) to OpenAI's Codex CLI (GPT-5.x models) — with Claude planning and quality-controlling, Codex implementing, and a hardened broker handling everything the Codex sandbox cannot.

Codex usage bills to your ChatGPT plan; orchestration runs on your Claude plan. The two AIs cross-check each other: uncorrelated errors are the point.

```mermaid
flowchart LR
    A[Claude - cloud\nplans, reviews, integrates] -->|MCP tools via\ndesktop bridge| B[Codex Broker\nMCPB extension, unsandboxed]
    B -->|spawns| C[Codex CLI sandbox\nGPT-5.x implements and commits]
    B -->|git push / pull\ngh repo create| D[(GitHub)]
    A -->|clone and verify| D
```

## What's in this repo

| Path | Contents |
|---|---|
| `server/` | Broker MCP server source (Node, zero-dependency runtime + @modelcontextprotocol/sdk), 24-test suite with a mock Codex harness |
| `skill/` | `codex-delegation` Claude skill — role architecture, git protocol, GPT prompting conventions |
| `dist/` | Ready-to-install packages: `codex-broker.mcpb` (drag into Claude Desktop → Settings → Extensions) and `codex-delegation.skill` |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [Windows install guide](docs/INSTALL-WINDOWS.md) · [Field-testing lessons](docs/LESSONS.md) |

## Quick start

1. Prerequisites: Node 18.18+, `npm install -g @openai/codex`, `codex login` (ChatGPT subscription or API key), GitHub CLI (`gh auth login`) for repo operations.
2. Install `dist/codex-broker.mcpb`: Claude Desktop → Settings → Extensions → drag the file in.
3. Save `dist/codex-delegation.skill` to your Claude account (upload in the conversation or Settings → Skills).
4. Start a new Cowork session — the tools appear as `mcp__remote-devices__Codex_Broker__*`.

Full walkthrough with verification steps: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md).

## Tools

`codex_task` (sync, <45s jobs) · `codex_start` / `codex_status` / `codex_result` / `codex_cancel` (background jobs — the default for real work) · `codex_review` (read-only review) · `codex_resume` (continue a thread) · `git_push` / `git_pull` / `gh_repo_create` (broker-side git — see below).

## The security model, in one paragraph

Codex runs inside its own OS-level sandbox as a separate user, with filesystem writes confined to the target project and no network or credential access — it can create, edit, and commit, but can never push, pull, or touch your GitHub auth. Remote git operations go through dedicated broker tools that run outside the sandbox, are invoked explicitly by the orchestrating Claude after reviewing the work, never force-push, and validate every argument against injection. Credentials are never visible to either AI model. The broker refuses `danger-full-access` and approval-bypass flags at the argument-builder level.

## License

MIT — see [LICENSE](LICENSE).
