import {createConnection} from "node:net";

/// Minimal one-shot JSON-RPC client over UDS — used by the stress harness to ask the
/// sidecar a question and disconnect (M3.12 / Fix 3). Not a general-purpose client; we
/// don't need keep-alive, multiplexing, or notifications. The full sidecar IPC contract
/// lives in `src/ipc/server.ts`; this is just enough to send one request and read one
/// response on a fresh socket.
///
/// Why not pull in a JSON-RPC library: the harness binary should stay zero-dep beyond
/// `viem` (already required for the WAL writer). One small connection helper is cheaper
/// than another transitive node_modules surface.

export interface RpcCallOptions {
    socketPath: string;
    method: string;
    params?: unknown;
    /// Wait at most this long before failing the call. Defaults to 5 s — long enough to
    /// tolerate a sidecar busy with disk I/O, short enough that a typo'd socket path fails
    /// fast.
    timeoutMs?: number;
}

export interface RpcOk<T> {
    ok: true;
    result: T;
}
export interface RpcErr {
    ok: false;
    error: {code: number; message: string; data?: unknown};
}
export type RpcReply<T> = RpcOk<T> | RpcErr;

/// Issue one JSON-RPC call against the sidecar's UDS server. Resolves with a discriminated
/// `RpcReply<T>` so callers see explicit `error` / `result` paths instead of try/catch.
/// Connection-level failures (ENOENT on the socket, ECONNREFUSED, timeout, malformed
/// response) reject the returned promise.
export function rpcCall<T = unknown>(opts: RpcCallOptions): Promise<RpcReply<T>> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    return new Promise<RpcReply<T>>((resolve, reject) => {
        const sock = createConnection(opts.socketPath);
        let buf = "";
        let done = false;
        const cleanup = (): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.removeAllListeners();
            sock.end();
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`rpcCall timed out after ${timeoutMs}ms (${opts.method})`));
        }, timeoutMs);
        sock.setEncoding("utf8");
        sock.on("connect", () => {
            const payload = {jsonrpc: "2.0", id: 1, method: opts.method, params: opts.params ?? {}};
            sock.write(`${JSON.stringify(payload)}\n`);
        });
        sock.on("data", (chunk: string | Buffer) => {
            buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0 || done) return;
            const line = buf.slice(0, nl);
            cleanup();
            try {
                const parsed = JSON.parse(line) as {
                    jsonrpc?: string;
                    id?: number;
                    result?: T;
                    error?: {code: number; message: string; data?: unknown};
                };
                if (parsed.error) {
                    resolve({ok: false, error: parsed.error});
                } else {
                    resolve({ok: true, result: parsed.result as T});
                }
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        sock.on("error", (err: Error) => {
            cleanup();
            reject(err);
        });
    });
}

/// Poll the sidecar's `chain.venues.status` until at least `expectedCount` venues are in the
/// mirror cache, or `timeoutMs` elapses. Used by the stress harness to make bootstrap mode
/// race-free: we don't want to start the spend loop while the venue mirror is still
/// catching up to the WAL events the harness just wrote (each `VENUE_REGISTERED` is one
/// admin tx — chain-side latency dominates).
///
/// Returns the final `cacheSize`. Resolves when the count is reached; rejects on timeout
/// or any non-recoverable error (the sidecar isn't reachable, the response shape is
/// unexpected, etc.).
export interface WaitForVenuesOptions {
    socketPath: string;
    expectedCount: number;
    timeoutMs?: number;
    /// Polling interval. 500 ms is a fair balance between "responsive when the mirror lands
    /// the last venue" and "not a thundering herd against the IPC server during a 60 s wait".
    pollIntervalMs?: number;
}

export async function waitForVenues(opts: WaitForVenuesOptions): Promise<number> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const pollMs = opts.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastSeen = -1;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const reply = await rpcCall<{enabled: boolean; cacheSize?: number}>({
            socketPath: opts.socketPath,
            method: "chain.venues.status",
            timeoutMs: Math.min(remaining, 5_000),
        });
        if (!reply.ok) {
            throw new Error(`chain.venues.status RPC error: ${reply.error.message}`);
        }
        if (!reply.result.enabled) {
            // Sidecar is offline — venues won't ever land via the mirror; bail loud.
            throw new Error("chain.venues.status returned {enabled: false} — sidecar lacks chain plumbing");
        }
        const cacheSize = reply.result.cacheSize ?? 0;
        lastSeen = cacheSize;
        if (cacheSize >= opts.expectedCount) return cacheSize;
        await new Promise<void>((r) => setTimeout(r, Math.min(pollMs, deadline - Date.now())));
    }
    throw new Error(
        `waitForVenues timed out after ${timeoutMs}ms — saw ${lastSeen}/${opts.expectedCount} venues in cache`,
    );
}
