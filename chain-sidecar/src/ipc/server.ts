import {createServer, type Server, type Socket} from "node:net";
import {unlink} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname} from "node:path";
import {mkdir} from "node:fs/promises";
import {log as rootLog, type Logger} from "../log.js";
import {
    ErrorCode,
    RpcError,
    makeError,
    makeSuccess,
    type JsonRpcRequest,
    type JsonRpcResponse,
} from "./protocol.js";

/// Handler signature: receives params + a per-call logger, returns the result (or throws).
export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown> | unknown;

export interface HandlerContext {
    log: Logger;
    /// Method name — useful for handlers that route on an action sub-field.
    method: string;
    /// Server reference so a handler can register its own teardown (rare; mostly for `shutdown`).
    server: RpcServer;
}

/// JSON-RPC 2.0 over a Unix domain socket with line-delimited (`\n`) framing.
///
/// Why line-delimited rather than length-prefixed:
///   - Matches what the C++ rctctl client and the game's `ChainHandlers` already speak; no
///     framing translation in the middle.
///   - Trivial to debug with `socat - UNIX-CONNECT:<path>` while developing.
///
/// One method per request, no batching. The game's outbox is what carries volume; this socket
/// is for control-plane traffic (status, config, manual triggers).
export class RpcServer {
    private readonly handlers = new Map<string, Handler>();
    private readonly server: Server;
    private readonly sockets = new Set<Socket>();
    private listening = false;

    constructor(
        private readonly socketPath: string,
        private readonly log: Logger = rootLog,
    ) {
        this.server = createServer((socket) => this.onConnection(socket));
        this.server.on("error", (err) => this.log.error({err}, "rpc server error"));
    }

    register(method: string, handler: Handler): void {
        if (this.handlers.has(method)) {
            throw new Error(`rpc: handler already registered: ${method}`);
        }
        this.handlers.set(method, handler);
    }

    methods(): string[] {
        return [...this.handlers.keys()].sort();
    }

    async listen(): Promise<void> {
        // UDS sockets are filesystem entries; a stale one from a previous run would block bind.
        // Removing it unconditionally is safe because we only accept one sidecar per socket path.
        if (existsSync(this.socketPath)) {
            await unlink(this.socketPath).catch(() => undefined);
        }
        await mkdir(dirname(this.socketPath), {recursive: true}).catch(() => undefined);
        await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            this.server.once("error", onError);
            this.server.listen(this.socketPath, () => {
                this.server.off("error", onError);
                this.listening = true;
                resolve();
            });
        });
        this.log.info({socket: this.socketPath, methods: this.methods()}, "rpc server listening");
    }

    async close(): Promise<void> {
        if (!this.listening) return;
        for (const s of this.sockets) s.destroy();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        await unlink(this.socketPath).catch(() => undefined);
        this.listening = false;
        this.log.info({socket: this.socketPath}, "rpc server closed");
    }

    // ---------------------------------------------------------------------------

    private onConnection(socket: Socket): void {
        this.sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";

        socket.on("data", (chunk: string) => {
            buffer += chunk;
            // Pull off any complete lines; keep the rest until the next chunk arrives.
            for (;;) {
                const nl = buffer.indexOf("\n");
                if (nl < 0) break;
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line.length > 0) void this.handleLine(line, socket);
            }
        });
        socket.on("error", (err) => this.log.warn({err}, "rpc socket error"));
        socket.on("close", () => this.sockets.delete(socket));
    }

    private async handleLine(line: string, socket: Socket): Promise<void> {
        let req: JsonRpcRequest;
        try {
            req = JSON.parse(line) as JsonRpcRequest;
        } catch (err) {
            this.write(socket, makeError(null, ErrorCode.ParseError, "invalid JSON"));
            this.log.warn({err, line}, "rpc parse error");
            return;
        }

        const id = req.id ?? null;
        if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
            this.write(socket, makeError(id, ErrorCode.InvalidRequest, "expected JSON-RPC 2.0 request"));
            return;
        }

        const handler = this.handlers.get(req.method);
        if (!handler) {
            this.write(socket, makeError(id, ErrorCode.MethodNotFound, `method not found: ${req.method}`));
            return;
        }

        const callLog = this.log.child({rpc: req.method, id});
        try {
            const result = await handler(req.params, {log: callLog, method: req.method, server: this});
            this.write(socket, makeSuccess(id, result));
        } catch (err) {
            if (err instanceof RpcError) {
                this.write(socket, makeError(id, err.code, err.message, err.data));
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            callLog.error({err}, "rpc handler threw");
            this.write(socket, makeError(id, ErrorCode.InternalError, msg));
        }
    }

    private write(socket: Socket, response: JsonRpcResponse): void {
        socket.write(`${JSON.stringify(response)}\n`);
    }
}
