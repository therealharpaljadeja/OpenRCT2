/// MetricsAggregator (plan §4.6 / M3.9). Pulls submit→confirm events from the relayer pool,
/// keeps timestamped samples for rate + percentile computation over a rolling window, and
/// exposes a snapshot the IPC layer joins with subsystem gauges to render `chain.throughput`.
export {
    MetricsAggregator,
    DEFAULT_METRICS_WINDOW_MS,
    DEFAULT_MAX_LATENCY_SAMPLES,
    type MetricsRecorder,
    type MetricsAggregatorOptions,
    type ThroughputSnapshot,
} from "./aggregator.js";
