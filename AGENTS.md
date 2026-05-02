## Background

This is a clone of the repo OpenRCT2, an open source community supported edition of Roller Coaster Tycoon 2.

## Project

In this project, we are creating a dramatic twist. We will be adding a new kind of management 'window' into the game which is actually a functioning terminal with
the ultimate purpose of running a coding agent, like Claude Code or Codex, with an interactive CLI to take actions in the game itself.

It's like Claude Plays Pokemon, but this project is "Claude Code plays Roller Coaster Tycoon" and instead of a visual interface, it will be a purely CLI driven, using a CLI we build from scratch.

The spirit of the project is for Claude Code to feel like a friendly robot playing the game with the user with the same limitations that the user has in the game interface. Claude is using CLI because it is Claude, not because it is meant to make technical modifications. We are, in a sense, further developing the gameplay with this robot assistant, not simply hacking internals unfairly.

The exact architecture and implementation details of this project are still to be determined.

## Attitude

This is a brand-new creative fork that we are hacking on from scratch. We do not need to worry about 'legacy' compatibility or any eventual merge with the open source project.

## Game Files

Official game files purchased on Steam are located at `$HOME/Library/Application Support/OpenRCT2/`

## Agent Session Logs

Each in-game AI agent session is automatically logged to `agent-logs/` in the repo root (gitignored).

- **Location:** `agent-logs/`
- **Markdown logs (primary):** `agent-session-YYYYMMDD-HHMMSS-ParkName.md`
- **HTML logs (optional):** `agent-session-YYYYMMDD-HHMMSS-ParkName.html`
- **Metadata:** `agent-session-YYYYMMDD-HHMMSS-ParkName.json`
- **Disabled in:** Headless mode (test suite runs)

### Log Formats

**Markdown (.md)** - Primary format, always generated
- Dense, LLM-friendly format ideal for review by agents
- User prompts and assistant responses
- Tool calls with inputs and outputs
- ~7x smaller than raw JSONL, ~20x smaller than HTML
- No external dependencies (just python3)

**HTML (.html)** - Browser-viewable format, always generated
- Converted from markdown using `scripts/markdown_to_html.py`
- Dark theme with syntax-highlighted code blocks
- No external dependencies (just python3)

### Manual Conversion

Convert any Claude session to markdown manually:
```bash
# Convert specific JSONL file
scripts/session_to_markdown.py ~/.claude/projects/-Users.../abc123.jsonl -o session.md

# Convert most recent session from a project directory
scripts/session_to_markdown.py ~/.claude/projects/-Users-foo-workspace/

# Include thinking blocks (collapsed by default)
scripts/session_to_markdown.py session.jsonl --include-thinking
```

### Requirements

Both markdown and HTML generation require only `python3` (usually pre-installed).

## Autoplay & Turn Detection

The AI Agent terminal supports autoplay mode, which automatically sends prompts from a rotation when Claude finishes its turn.

### How Turn Detection Works

Turn completion is detected by monitoring Claude Code's native session files in `~/.claude/projects/`:
- Claude writes JSONL files in real-time as it processes responses
- The `SessionFileMonitor` watches these files for new assistant messages
- After ~2.5 seconds of no new output, a turn is considered complete
- This approach is reliable and doesn't require hooks or external signaling

### JSON-RPC Status

The `agent.status` endpoint now includes turn completion info:
```json
{
  "status": "running",
  "turnComplete": true,
  "lastTurnCompleteTimestamp": 1702600000
}
```

## Build Shortcut

Use `cmake --build build --target agent_bundle -j8` to build the GUI, CLI, and sprite assets together. Configure once with `cmake -S . -B build -G Ninja ...`, then rely on this target for incremental work.

Be advised that other session may be modifying the project at the same time, and this can result in sporadic build failures in unrelated regions. Do not concern yourself with build failures beyond the immediate scope of your feature work.

## Game Logs

Run the game with logging enabled using the `--log-file` option:

```bash
# Run with verbose logging to a file
./build/OpenRCT2.app/Contents/MacOS/OpenRCT2 --verbose --log-file game-logs/session.log

# Or with a timestamped filename
./build/OpenRCT2.app/Contents/MacOS/OpenRCT2 --verbose --log-file game-logs/$(date +%Y%m%d-%H%M%S).log
```

- **Location:** `game-logs/` (gitignored)
- Logs include: `INFO`, `WARNING`, `ERROR` messages
- Use `--verbose` to also include `VERBOSE` level messages
- Logs are appended, so multiple runs accumulate in the same file

## Testing

Run from `build/`:

- `ctest` - Runs all tests (validation + E2E scenarios)
- `ctest -R rctctl_validation` - Fast CLI validation tests (~1s, no game required)
- `ctest -R agent_scenarios` - Full E2E tests (headless game + rctctl commands)

Test suite components:
- **CLI validation** (`test/scenarios/test_cli_validation.py`) - Tests error messages, help text, argument validation. Does not require running game.
- **E2E scenarios** (`test/scenarios/run_scenarios.py`) - Boots `openrct2-cli` in headless mode and drives `rctctl` commands end-to-end.

Binaries required: `openrct2-cli` + `rctctl` (built via `agent_bundle` target).

The legacy GoogleTest suite is opt-in via `-DWITH_TESTS=ON`.

## Architecture

The document CODING_AGENT.md contains a high-level architectural overview of our AI agent integration.

## CLI Patterns

For work on the `rctctl` CLI be sure to reference and abide by `RCTCTL.md`

## In-game Agent Bug Reports

The in-game AI agent can produce bug reports. This helps us iterate more quickly on its concerns and identified issues.

There are a few ways we can address a bug:
* clarifying the environmental info
* * `rctctl` help text
* * in-game agent's base prompt; `ai-agent-workspace/IN_GAME_AGENT.md`
* * `rctctl` semantic error text
* actually making functional changes (should only happen when we need to fix actual broken functionality)
