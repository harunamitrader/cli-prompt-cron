# Changelog

## [Unreleased]

## [1.0.1] - 2026-03-28

### Fixed
- **Windows cmd quoting**: `cmd /c` mangled inner double quotes in complex command strings (e.g. `--system-prompt "..." -p "..."`), causing the prompt to arrive as empty. Switched to `powershell -Command` on Windows, which handles quoted arguments correctly.
- **Codex non-interactive mode**: `codex "..."` requires a TTY and fails in cron. Updated SKILL.md to use `codex exec "..."` for non-interactive execution.
- **Claude system prompt confusion**: `--system-prompt "Non-interactive cron agent..."` caused Claude to answer about cron tools instead of the actual task. Revised to a neutral instruction.
- **README**: Fixed placeholder GitHub URL and git clone URL. Corrected result file format (`.txt` not JSON). Added `--system-prompt` to job example. Added Codex `exec` note.

### Added
- **Permission confirmation flow** in SKILL.md: When adding a job, if no permission flags are specified, the AI presents a numbered menu of options (no-permission, Write, Bash, WebSearch, etc.) before creating the job.
- **Automatic system prompt** in SKILL.md: All Claude Code jobs now automatically include `--system-prompt "Execute the task immediately. Do not ask for confirmation or clarification."` to suppress interactive confirmation requests.
- **Natural language setup and usage** instructions in README.

## [1.0.0] - 2026-03-28

### Added
- File-based cron daemon for AI CLIs (Claude Code, Gemini CLI, Codex)
- Browser dashboard at `http://localhost:3300` (vanilla HTML/CSS/JS, no build step)
- Real-time log streaming via Server-Sent Events (SSE)
- Execution results saved per-job to `~/.cli-prompt-cron-ui/results/`
- Job management via `~/.cli-prompt-cron-ui/jobs/*.json`
- Hot-reload with Chokidar (add / edit / delete jobs without restarting daemon)
- `start.js`: one-command launch — daemon + UI server + auto browser open
- Per-job timezone support
- Graceful shutdown on SIGINT / SIGTERM / SIGBREAK
- Skills for Claude Code, Gemini CLI, Codex (`skills/SKILL.md`)
- API endpoints: `GET /api/jobs`, `GET /api/results`, `GET /api/logs/stream`
