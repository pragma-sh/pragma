# Latency incident checklist

Work top-down. Check a box only when you have evidence, not a guess.

## Observability

- [ ] Unique trace ID on every request (`traceparent` / `x-request-id`)
- [ ] Trace ID propagated across all hops, including async workers and queues
- [ ] Child spans for DB, cache, HTTP, disk, and queue operations
- [ ] Pool acquire / lock wait instrumented separately from work
- [ ] Span timestamps from a monotonic clock where possible
- [ ] Adaptive / tail sampling: keep 100% of errors and slow traces
- [ ] Metrics: p50/p95/p99 (ideally p999) per endpoint and per downstream
- [ ] Histograms aggregated correctly (no averaging of percentiles)
- [ ] RED/USE dashboards for the fat-hop service

## Scope the incident

- [ ] Confirm client vs edge vs origin (CDN/browser ruled in or out)
- [ ] Note start time; correlate with deploys, traffic, cron, dependency status
- [ ] Separate "slow successful" from "timeout / 5xx" — different playbooks
- [ ] Compare one AZ / region / shard against others (blast radius)
- [ ] Compare canary / new version against baseline if a deploy is involved
- [ ] Confirm whether throughput rose, fell, or stayed flat with latency

## Timeouts and backpressure

- [ ] Every outbound call has an explicit client timeout
- [ ] Timeouts decrease toward the leaf (no inversion)
- [ ] Server cancels work when the client deadline expires
- [ ] Retries ≤ 2, exponential backoff, full jitter
- [ ] Circuit breakers (or equivalent) on critical dependencies
- [ ] Connection pools bounded; fail fast when exhausted (no unbounded queue)
- [ ] Pool in-use vs max monitored and alerted
- [ ] Load shed / admission control when queues exceed the SLO budget

## Database and cache

- [ ] Slow query log on (threshold ≤ 100 ms, tighter if the SLO demands)
- [ ] Hot queries reviewed with `EXPLAIN ANALYZE` or equivalent
- [ ] No N+1 on hot paths (verify via child-span counts)
- [ ] Pool wait time instrumented separately from query time
- [ ] Cache TTLs jittered; stampede protection (single-flight / locks)
- [ ] Cache hit / miss rate monitored
- [ ] Lock waits and deadlocks checked during the window

## Infrastructure

- [ ] CPU, memory, disk, network saturation checked on fat-hop hosts
- [ ] VM steal time checked (`st` / `stolen`)
- [ ] TCP retransmit rate < ~0.1%
- [ ] DNS cached, not resolved per request on the hot path
- [ ] TLS session reuse / termination offload considered
- [ ] Logging async; the request path never blocks on disk flush
- [ ] No noisy neighbor on shared disks, NICs, or DB instances
- [ ] Ephemeral ports / `TIME_WAIT` / fd limits checked under peak concurrency
- [ ] Zone-aware routing verified for multi-hop paths

## Code-level

- [ ] Hot path free of accidental global locks / coarse mutexes
- [ ] Serialization profiled for large payloads
- [ ] Allocation / GC pressure reviewed if the runtime is managed
- [ ] No `sleep` or blocking I/O on event-loop or limited worker threads
- [ ] Independent outbound calls issued concurrently where safe
- [ ] No accidental sync I/O in "async" handlers

## Before you close

- [ ] Root cause named with evidence (trace ID + metric + host signal)
- [ ] Fix verified against p99, not only p50, under representative load
- [ ] Guardrail added (alert, pool metric, timeout test, load test)
- [ ] Runbook or this checklist updated if a new villain appeared
- [ ] SLO burn rate / error budget impact documented for the postmortem
