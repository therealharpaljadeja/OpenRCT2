/// Minimal JSON-RPC 2.0 types for the line-delimited transport the sidecar speaks over UDS.
/// We only support a single named method per request — no batching — which matches what the
/// game's `ChainHandlers.cpp` already produces and keeps the framing trivial.

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: unknown;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface JsonRpcSuccess {
    jsonrpc: "2.0";
    id: string | number | null;
    result: unknown;
}

export interface JsonRpcError {
    jsonrpc: "2.0";
    id: string | number | null;
    error: {code: number; message: string; data?: unknown};
}

/// Standard JSON-RPC 2.0 error codes. Code ranges -32000..-32099 are reserved for
/// implementation-defined server errors; we keep `-32000` as the generic fallback.
export const ErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    ServerError: -32000,
} as const;

export class RpcError extends Error {
    constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown,
    ) {
        super(message);
    }
}

export function makeError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcError {
    return {
        jsonrpc: "2.0",
        id,
        error: data === undefined ? {code, message} : {code, message, data},
    };
}

export function makeSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
    return {jsonrpc: "2.0", id, result};
}
