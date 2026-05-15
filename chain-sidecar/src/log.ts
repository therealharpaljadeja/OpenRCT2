import pino from "pino";

/// Single shared logger. Level defaults to `info`; bump to `debug` via `LOG_LEVEL=debug`.
/// Pino's structured JSON output is what the CMake-driven `agent_bundle` parent process and
/// the in-game terminal both consume — so any log line should be machine-parseable.
export const log = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: {pid: process.pid, name: "rct2-chain-sidecar"},
    timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof log;
