# Diagnosing Latency in a Distributed Service

A repeatable path from symptom → fat hop → root cause → verified fix.

## Core Mental Model

Request latency is the sum of three components at every hop:

```
latency ≈ Σ (queuing delay + service time + network time)
```

| Component     | What it is                                                               |
| ------------- | ------------------------------------------------------------------------ |
| Queuing delay | Waiting for a thread, connection, lock, CPU run queue, or kernel backlog |
| Service time  | Actual work: CPU, serialization, query execution, business logic         |
| Network time  | RTT, TLS handshake, wire serialization, proxy hops, DNS                  |

### Read percentiles, not averages

| Signal                                | What it usually means                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| p50 rising                            | Capacity problem — under-provisioned or slow common path      |
| p99/p999 rising, p50 flat             | Tail problem — GC, locks, retries, pool waits, noisy neighbor |
| Mean significantly larger than median | Heavy tail or a minority of catastrophic outliers             |

Always optimize the tail first. It is almost always a synchronization choke (lock contention, GC pause, head-of-line blocking, thundering herd) or a misconfiguration (pool too small, timeout too tight, retry storm).

### Little's Law connects latency and capacity

```
concurrency ≈ throughput × latency
```

A latency spike that looks small (200 ms → 400 ms) silently doubles in-flight work and can tip resource pools into exhaustion.

### Write a latency budget before diagnosing

```
SLO: POST /checkout p99 < 800 ms
  edge + auth:         50 ms
  checkout service:   100 ms
  payment:            400 ms
  inventory:          150 ms
  notification:       100 ms
  total:              800 ms
```

Any hop over its budget is a candidate. If every hop is under budget but the sum exceeds the SLO, you have serialization of work that could be parallel — or hidden queuing gaps between spans.

### Client latency ≠ server latency ≠ user latency

A "fast" server histogram with unhappy users means the pain is before the handler starts (load-balancer queue, accept backlog) or after the response leaves (CDN, last mile, client main thread). Server handler timers commonly exclude accept-queue wait.

---

## Measurement Pitfalls

Never trust a latency graph without checking these first:

### 1. Averaging percentiles across pods or time buckets

`avg(p99)` across pods underestimates the true p99. Always aggregate raw histograms (HDR histograms, OpenTelemetry exponential histograms) and compute percentiles from the merged distribution.

### 2. Coordinated omission

Load generators that wait for each response before sending the next hide tail latency. Under load, slow requests suppress subsequent arrivals, making the measured p99 look better than production reality.

**Fix:** Use arrival-rate-driven tests (open loop, constant arrival rate) with scheduled start times. Record both intended issue time and completion time.

### 3. Sampling bias

Head-based sampling at 1% drops the exact slow traces you need. Use tail sampling (always keep errors and traces above a latency threshold) or promote slow/error traces before discard.

### 4. Clock skew

If two services disagree by even 50 ms, cross-service gap analysis becomes unreliable. Prefer parent-based duration (each child reports its own wall time) over comparing absolute clocks across hosts.

### 5. Coarse histogram buckets

Prometheus buckets at `le="0.1", "0.25", "0.5", "1"` cannot distinguish 110 ms from 240 ms. For SLO-critical paths near a budget edge, use finer buckets around the target (e.g., 50 ms steps near 800 ms).

### 6. Different measurement points include different things

| Measurement point      | What it includes                                                     |
| ---------------------- | -------------------------------------------------------------------- |
| Browser / mobile TTFB  | DNS + TCP + TLS + edge + origin queue + first byte                   |
| Edge / LB latency      | Origin queue + service time (no client RTT)                          |
| Server handler timer   | Often excludes accept-queue wait (common blind spot)                 |
| Distributed trace wall | Sum of spans + gaps; misses client-side JS / CDN if not instrumented |

### 7. Quick curl latency diagnostic

Save this as a curl format file:

```
time_namelookup:  %{time_namelookup}
time_connect:     %{time_connect}
time_appconnect:  %{time_appconnect}
time_starttransfer: %{time_starttransfer}
time_total:       %{time_total}
```

Run: `curl -w '@latency-format.txt' -o /dev/null -s <url>`

---

## Seven-Step Diagnosis Workflow

### Step 1: Establish the baseline

Before touching anything, collect these signals:

- **p50, p95, p99, p999** for every internal RPC, not just the edge endpoint
- **Error rate** by status code and endpoint (4xx vs 5xx vs timeouts)
- **Throughput at the observed latency** — is the system saturated?
- **Clock skew** across hosts (ideally < 10 ms; > 100 ms means waterfalls lie)
- **When it started** — correlate with deploys, traffic spikes, dependency incidents, cron windows
- **Blast radius** — one shard, one AZ, one customer cohort, or everywhere?

### Step 2: Identify the fat hop

Sort traces by total duration descending. Open the slowest and read the waterfall.

| Pattern                                      | Likely cause                                         |
| -------------------------------------------- | ---------------------------------------------------- |
| One span ≈ 90% of wall time                  | That service is the bottleneck                       |
| All spans slow; idle gaps between them       | Network, TLS redo, or proxy buffering                |
| Thin spans with thick dark gaps between them | Queuing (pool wait, thread starvation, backlog)      |
| Periodic spikes across unrelated traces      | GC, cron/admin lock, noisy-neighbor VM               |
| Fan-out: many siblings, wall ≈ slowest child | Parallel path is fine; slowest sibling is the issue  |
| Fan-out: wall ≈ sum of children (no overlap) | Accidental sequential calls that should be parallel  |
| Span starts late relative to parent          | Accept queue / scheduler delay before handler starts |

Found your fat hop? Drill into that service. Gap _between_ services? Check connection pools (keep-alive, max connections, idle timeout) and TLS session reuse.

### Step 3: Drill into the fat-hop service

1. **Instrument every external call** (DB, cache, HTTP, disk, queue) as a child span. Teams that instrument only HTTP handlers leave the DB dark — and the DB is usually the answer.

2. **Separate dispatch from work.** Time deserialize + routing separately from business logic.

3. **Watch for sync blocking on async runtimes.** A blocking `lock()` or `sleep` on an event-loop thread spikes latency for every in-flight request.

4. **Split "wait for resource" from "use resource".** Pool acquire vs query execute; lock wait vs critical section; disk queue vs disk service time.

If no dominant span but wall time is still high, take a CPU profile (`pprof`, `perf`, `py-spy`, `async-profiler`).

### Step 4: Check system-level saturation

| Metric           | Saturation signal                                       |
| ---------------- | ------------------------------------------------------- |
| CPU              | > 80% sustained; run-queue > 2× vCPU → scheduling delay |
| Memory           | Major page faults → allocator / GC stalls               |
| Disk I/O         | `await` > 10 ms or `%util` ≈ 100% → swap or log storm   |
| Network          | rx/tx drops; TCP retransmits > 0.1%                     |
| Connections      | `ss -s` TIME_WAIT storm → ephemeral port exhaustion     |
| Steal time (VMs) | Non-trivial `st` in `top` → noisy neighbor              |
| File descriptors | Near `ulimit` → accept/connect failures and stalls      |

Add headroom before micro-optimizing. CPU-only autoscaling misses memory-pressure latency; prefer custom metrics or p99 latency as the scaling signal.

### Step 5: Audit retries, timeouts, and circuit breakers

Misconfigured reliability machinery is a top cause of production tail latency.

| Pattern                        | Problem                                                        | Fix                                                                                        |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Retry storm                    | Client timeout < dependency p99 → every call retries           | Set timeout from dependency p99; add exponential backoff with full jitter; cap retries ≤ 2 |
| No circuit breaker             | Client keeps hammering a slow dependency                       | Add circuit breaker on critical dependencies                                               |
| No deadline propagation        | A slow leaf holds threads across the entire call graph         | Propagate deadlines; cancel work when client goes away                                     |
| Timeout inversion              | Client timeout < server work budget → retry while server works | Ensure timeouts decrease toward the leaf                                                   |
| Hedged requests without cancel | Duplicate work doubles load                                    | Cancel redundant requests promptly                                                         |

### Step 6: Look for thundering herds

Cache TTL expiry or a cron at `:00` makes every replica hit the same backend simultaneously.

- **Jitter TTLs:** `TTL × random(0.8, 1.2)`
- **Stagger crons:** randomize start times
- **Single-flight / coalescing:** on cache miss, only one request hits the backend
- **Distributed locks:** for run-once jobs

### Step 7: Confirm with controlled reproduction

Capture a representative trace and traffic mix. Replay at production concurrency (open loop if possible). Inject **one** variable and watch p99 — not the mean — before declaring victory.

Use chaos tools (Toxiproxy, Chaos Mesh) to validate that timeouts and breakers behave correctly under induced dependency latency.

---

## Recurring Villains Reference

| Symptom                              | Most likely                                    | Next likely                  |
| ------------------------------------ | ---------------------------------------------- | ---------------------------- |
| p99 high, p50 normal                 | GC / compaction / lock                         | Retry-on-timeout             |
| All latencies high, all hops         | Connection pool exhaustion                     | Network congestion           |
| Spikes every 5–15 min                | Config reload, log rotate, K8s leader election | TLS cert rotation            |
| Latency proportional to payload size | Serialization (JSON → protobuf)                | Full table / large scans     |
| Latency after deploy, then heals     | Cache cold start                               | JIT warm-up                  |
| Only first request is slow           | TLS / pool init                                | Lazy singleton               |
| All services slow at once            | Shared DNS / LB / Kafka / DB                   | AZ or cloud provider issue   |
| Latency only under concurrency       | Lock contention / pool wait                    | Thread pool saturation       |
| Good traces, bad user experience     | Client-side / CDN / last mile                  | Browser main-thread blocking |
| Latency rises with fan-out width     | Head-of-line blocking / sequential calls       | Shared downstream saturation |
| Cross-AZ calls suddenly slow         | AZ networking / MTU / peering                  | Mis-routed traffic           |

---

## Worked Examples

### Example A — Pool exhaustion behind a "slow DB" span

**Symptom:** `POST /api/checkout` p99 = 4.2 s, p50 = 180 ms.

Trace waterfall shows `payment-service` consuming 3.8 s (the fat hop). Inside payment-service, `charge()` has a 3.5 s dark gap before the first DB byte. DB pool is 128/128 active. `SHOW FULL PROCESSLIST` shows everything in `COMMIT`, waiting on WAL flush.

**Root cause:** Payment DB WAL on shared EBS hitting IOPS burst limits during a concurrent bulk-export job. Commits block 200–500 ms, the pool backs up, every `charge()` queues.

**Fix:** Export from a read replica; raise IOPS; split read/write pools. p99 → ~520 ms.

**Lesson:** A fat DB span is often _waiting for a connection_, not a slow query. Instrument pool wait separately from query execution.

### Example B — Retry storm from a tight timeout

**Symptom:** `GET /search` p99 jumps 300 ms → 2.8 s after a dependency deploy. Error rate barely moves.

Metrics show search-service outbound calls to ranking-service at 2.1× traffic. Ranking's p50 moved 95 ms → 130 ms (still "okay"), but the client timeout is 100 ms with 1 retry and no jitter.

**Mechanism:** Ranking slips past the 100 ms timeout → search cancels and retries immediately → ranking still finishes the original work (wasted capacity) → offered load ≈ 2× → ranking slows further → more timeouts.

**Fix:** Raise client timeout to ≥ ranking p99 + margin (~250 ms); cap retries at 1 with full jitter; add a circuit breaker.

**Lesson:** Set timeouts from **dependency p99**, not from a round number that feels snappy.

### Example C — Sequential fan-out that should be parallel

**Symptom:** Product page p95 = 900 ms. Every dependency is fast.

The waterfall shows non-overlapping children: catalog.get (120 ms) → pricing.get (150 ms) → inventory.get (180 ms) → reviews.get (200 ms). Wall time ≈ sum of children because each starts after the previous finishes.

**Fix:** Issue independent calls concurrently. Wall time becomes max(child) + overhead (~200–250 ms).

**Lesson:** Always check whether sibling spans overlap. Non-overlap on independent work is free latency.

### Example D — GC / allocation tail

**Symptom:** JVM service, p50 stable at 40 ms; p99 spikes to 1–2 s every few minutes. Spikes align across pods.

Continuous profiler shows high allocation rate in the JSON response builder. GC logs show occasional old-gen pauses of 800 ms–1.5 s. The handler span contains a long gap with no child spans.

**Fix:** Reduce hot-path allocations (reuse buffers, smaller payloads, streaming responses); tune GC or move to a lower-pause collector.

**Lesson:** Periodic, cross-replica spikes with dark gaps and healthy dependency spans point at runtime pauses (GC, safepoints), not the network.

### Example E — N+1 queries hiding as "business logic"

**Symptom:** `GET /orders/{id}` p99 = 1.1 s after adding "line-item status." The trace shows one fat handler span, 1.05 s, no children.

After adding DB instrumentation: `SELECT order` (8 ms) + `SELECT line_item × 42` (~20 ms each, sequential) + `SELECT status × 42` (~5 ms each).

**Root cause:** ORM lazy-load loop — 84 queries where 2 joins would do.

**Fix:** Eager-load or a single joined query; assert child-span counts in tests for hot endpoints.

**Lesson:** Missing child spans look like "slow code." They are usually uninstrumented I/O.

### Example F — Head-of-line blocking on HTTP/1.1

**Symptom:** Mobile app feels sticky; server p99 looks fine (~80 ms).

The app opens few connections per host. Many small API calls share one HTTP/1.1 connection. One slow image or analytics call blocks subsequent API responses.

**Fix:** HTTP/2 or HTTP/3; connection coalescing; prioritize critical requests; move non-critical work off the critical path.

**Lesson:** Client-visible latency can be multiplexing / head-of-line blocking, invisible in per-handler server metrics.

### Example G — Cross-AZ tax

**Symptom:** p99 rises during evening peak, only on multi-hop checkout paths.

Same-AZ RTT ~0.5 ms vs cross-AZ ~2–5 ms (higher under congestion). The mesh occasionally schedules checkout → payment across AZs. A fan-out of 8 sequential cross-AZ calls adds tens of ms of pure RTT plus variance.

**Fix:** Zone-aware / topology-aware load balancing; keep request-scoped affinity.

**Lesson:** Microservices multiply RTT. Topology awareness is a latency feature.

### Example H — Async path: API is fast, users still wait

**Symptom:** `POST /export` returns 202 in 40 ms. Users report exports taking 30–90 s.

Queue depth on `export-jobs` climbs ~50 → ~8k at 09:00. Consumer lag tracks user wait time 1:1. Worker CPU ~95%. Producer rate exceeds consumer drain rate.

**Root cause:** User-perceived latency is **queue wait + processing**, not HTTP latency. The API only measures admission.

**Fix:** Scale consumers; shed or prioritize jobs; expose a job-age SLI; alert on lag, not only HTTP p99.

**Lesson:** For async workflows, instrument **admission → start → complete** as separate histograms.

### Example I — Sidecar / mesh tax

**Symptom:** After enabling a service mesh, p99 +40–80 ms everywhere. App profiles unchanged.

Traces show two extra spans per hop (egress proxy + ingress proxy), each ~5–15 ms at p50 and worse under connection churn. mTLS handshake spikes when idle timeouts kill connections too aggressively.

**Fix:** Tune idle and max connection lifetimes for keep-alive; enable connection pooling in the mesh; consider a lighter data plane for low-budget hops.

**Lesson:** Every new hop in the data path is a latency budget line item. Attribute mesh time separately from app time.

---

## Quick Decision Tree

```
Is there a trace for a slow request?
├─ No → Add instrumentation; stop guessing
└─ Yes → Open waterfall
         ├─ One fat span?
         │   ├─ External call is fat → dependency / pool / query
         │   └─ Local span fat, no children → profile CPU / locks / GC
         ├─ Dark gaps between thin spans?
         │   └─ Queuing: threads, pools, run queue, proxy
         ├─ Children sequential but independent?
         │   └─ Parallelize
         ├─ Outbound rate significantly higher than inbound rate?
         │   └─ Retries / hedges / fan-out amplification
         └─ Everything fine in traces, users still slow?
             └─ Client, CDN, DNS, multiplexing, or post-response work
```

---

## Incident Checklist

Work top-down. Check a box only when you have evidence, not a guess.

### Observability

- [ ] Unique trace ID on every request (`traceparent` / `x-request-id`)
- [ ] Trace ID propagated across all hops, including async workers and queues
- [ ] Child spans for DB, cache, HTTP, disk, and queue operations
- [ ] Pool acquire / lock wait instrumented separately from work
- [ ] Span timestamps use monotonic clock where possible
- [ ] Adaptive / tail sampling: keep 100% of errors and slow traces
- [ ] Metrics: p50/p95/p99 (ideally p999) per endpoint and per downstream
- [ ] Histograms aggregated correctly (no averaging of percentiles)
- [ ] RED/USE dashboards for the fat-hop service

### Scope the Incident

- [ ] Confirm client vs edge vs origin (CDN/browser ruled in or out)
- [ ] Note start time; correlate with deploys, traffic, cron, dependency status
- [ ] Separate "slow successful" from "timeout / 5xx" — different playbooks
- [ ] Compare one AZ / region / shard against others (blast radius)
- [ ] Compare canary / new version against baseline if a deploy is involved
- [ ] Confirm whether throughput rose, fell, or stayed flat with latency

### Timeouts and Backpressure

- [ ] Every outbound call has an explicit client timeout
- [ ] Timeouts decrease toward the leaf (no inversion)
- [ ] Server cancels work when the client deadline expires
- [ ] Retries ≤ 2, exponential backoff, full jitter
- [ ] Circuit breakers (or equivalent) on critical dependencies
- [ ] Connection pools bounded; fail fast when exhausted (no unbounded queue)
- [ ] Pool in-use vs max monitored and alerted
- [ ] Load shed / admission control when queues exceed the SLO budget

### Database and Cache

- [ ] Slow query log on (threshold ≤ 100 ms, tighter if SLO demands)
- [ ] Hot queries reviewed with `EXPLAIN ANALYZE` or equivalent
- [ ] No N+1 on hot paths (verify via child-span counts)
- [ ] Pool wait time instrumented separately from query time
- [ ] Cache TTLs jittered; stampede protection (single-flight / locks)
- [ ] Cache hit / miss rate monitored
- [ ] Lock waits and deadlocks checked during the window

### Infrastructure

- [ ] CPU, memory, disk, network saturation checked on fat-hop hosts
- [ ] VM steal time checked (`st` / `stolen`)
- [ ] TCP retransmit rate < ~0.1%
- [ ] DNS cached, not resolved per request on the hot path
- [ ] TLS session reuse / termination offload considered
- [ ] Logging is async; the request path never blocks on disk flush
- [ ] No noisy neighbor on shared disks, NICs, or DB instances
- [ ] Ephemeral ports / TIME_WAIT / fd limits checked under peak concurrency
- [ ] Zone-aware routing verified for multi-hop paths

### Code-Level

- [ ] Hot path free of accidental global locks / coarse mutexes
- [ ] Serialization profiled for large payloads
- [ ] Allocation / GC pressure reviewed if the runtime is managed
- [ ] No `sleep` or blocking I/O on event-loop or limited worker threads
- [ ] Independent outbound calls issued concurrently where safe
- [ ] No accidental sync I/O in "async" handlers

### Before You Close

- [ ] Root cause named with evidence (trace ID + metric + host signal)
- [ ] Fix verified against p99, not only p50, under representative load
- [ ] Guardrail added (alert, pool metric, timeout test, load test)
- [ ] Runbook or checklist updated if a new villain appeared
- [ ] SLO burn rate / error budget impact documented for the postmortem

---

## Tools Reference

| Layer                | Tool                                                 | What it tells you                              |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Distributed traces   | Jaeger, Zipkin, OpenTelemetry                        | Per-span latency, dependency graph, waterfall  |
| Metrics              | Prometheus + Grafana                                 | Aggregate percentiles, errors, saturation      |
| Continuous profiling | Parca, Pyroscope, Google Profiler                    | Always-on CPU/memory correlated with latency   |
| CPU/memory (ad-hoc)  | `pprof`, `async-profiler`, `py-spy`, `perf`          | Hot functions, locks, GC                       |
| Network              | `tcpdump`, Wireshark, `mtr`, `ss`, `sar`             | Retransmits, RTT, drops, TIME_WAIT             |
| Database             | `EXPLAIN ANALYZE`, `pg_stat_statements`, processlist | Plans, indexes, lock waits                     |
| Linux                | `top`/`htop`, `iostat`, `vmstat`, `dmesg`            | Steal, I/O await, OOM, kernel errors           |
| Chaos                | Toxiproxy, Chaos Mesh, Gremlin                       | Inject latency; validate timeouts and breakers |
| Load testing         | k6, vegeta, ghz                                      | Reproduce tail under controlled concurrency    |

---

## Axioms

1. The first 90% of latency diagnosis is reading a trace waterfall.
2. Never guess. If you cannot see it in a trace, add instrumentation first.
3. Retries without backoff are a denial-of-service attack on yourself.
4. Fast p50 + slow p99 ⇒ synchronization (lock, GC, pool, queue). Slow p50 + slow p99 ⇒ capacity or common-path work.
5. Tracing that drops all slow/error traces is negligent. Head-sample plus tail-sample.
6. The most expensive query is the one without an index. Second place: the one whose plan changed after a stats refresh.
7. Pool wait ≠ query time. Confusing them wastes hours.
8. If you cannot explain the latency with data, you have not collected the right data.
9. Latency budgets are architecture. Parallelism, caching, and topology are design choices, not after-the-fact tuning.
10. Prove the fix on the tail. A mean that moves while p99 does not is not a win.
