---
name: fixing-latency-issues
description: Use when root-causing latency in a distributed service — a slow user-facing endpoint, rising p99 with a flat p50, intermittent spikes, queue-backed work that "feels" slow, or a burning latency SLO. Covers the trace-waterfall workflow, measurement pitfalls that produce confident wrong answers, the recurring villains (pool exhaustion, retry storms, sequential fan-out, GC pauses, N+1, head-of-line blocking), and an incident checklist.
---

# Fixing latency issues

A repeatable path from symptom → fat hop → root cause → verified fix.

**The first 90% of latency diagnosis is reading a trace waterfall.** The remaining
10% is proving why that one span is slow. If you cannot see it in a trace, add
instrumentation before speculating.

## Mental model

Latency is not one number. It is a sum, repeated at every hop:

```
request latency ≈ Σ (queuing delay + service time + network time)
```

- **Queuing delay** — waiting for a thread, connection, lock, CPU run queue, or
  kernel backlog. Often invisible in code-level timers.
- **Service time** — actual work: CPU, serialization, query execution, business logic.
- **Network time** — RTT, TLS handshake, wire serialization, proxy hops, DNS.

### Percentiles over averages

| Signal                      | What it usually means                                        |
| --------------------------- | ------------------------------------------------------------ |
| p50 rising                  | Capacity problem (under-provisioned, slow common path)       |
| p99 / p999 rising, p50 flat | Tail problem: GC, locks, retries, pool waits, noisy neighbor |
| Mean ≫ median               | Heavy tail or a minority of catastrophic outliers            |

Optimize the tail first. It is almost always a synchronization choke (lock
contention, GC pause, head-of-line blocking, thundering herd) or a config mistake
(pool too small, timeout too tight, retry storm).

### Little's Law couples latency to capacity

```
concurrency ≈ throughput × latency
```

A latency spike that looks small (200 ms → 400 ms) silently doubles in-flight work
and can tip pools into exhaustion.

### Write the budget down before diagnosing

```
SLO: POST /checkout p99 < 800 ms
  edge + auth     50 ms
  checkout svc   100 ms
  payment        400 ms
  inventory      150 ms
  notification   100 ms
```

Any hop over budget is a candidate. If every hop is under budget but the sum
exceeds the SLO, you have **serialization of work that could be parallel** — or
hidden gaps between spans (queuing).

### Client, server, and "user" latency are different clocks

A "fast" server histogram with unhappy users means the pain is **before the handler
starts** (LB queue, accept backlog) or **after the response leaves** (CDN, last
mile, client main thread). Server handler timers commonly exclude accept-queue wait.

## Workflow

Read `references/measurement-pitfalls.md` **before trusting any graph** — averaged
percentiles, coordinated omission, sampling bias, clock skew, and coarse histogram
buckets all produce confident wrong answers.

### 1. Establish the baseline

- p50, p95, p99, p999 for every internal RPC, not just the edge.
- Error rate by status code and endpoint (4xx vs 5xx vs timeouts).
- Throughput at the observed latency — is the system saturated?
- Clock skew across hosts (< 10 ms fine; > 100 ms means waterfalls lie).
- When it started: deploy, traffic spike, dependency incident, cron window?
- Blast radius: one shard / AZ / customer cohort, or everywhere?

### 2. Identify the fat hop

Sort traces by total duration descending; open the slowest and read the waterfall.

| Pattern                                      | Likely cause                                        |
| -------------------------------------------- | --------------------------------------------------- |
| One span ≈ 90% of wall time                  | That service is the bottleneck                      |
| All spans slow; idle gaps between them       | Network, TLS redo, or proxy buffering               |
| Thin spans, thick dark gap between them      | Queuing (pool wait, thread starvation, backlog)     |
| Periodic spikes across unrelated traces      | GC, cron/admin lock, noisy-neighbor VM              |
| Fan-out: many siblings, wall ≈ slowest child | Parallel path OK; slowest sibling is the issue      |
| Fan-out: wall ≈ sum of children              | Accidental sequential calls that should be parallel |
| Span starts late relative to parent          | Accept queue / scheduler delay before handler       |

Fat hop → drill into that service. Gap _between_ services → connection pools
(keep-alive, max connections, idle timeout) and TLS session reuse.

### 3. Drill into the fat-hop service

1. **Instrument every external call** (DB, cache, HTTP, disk, queue) as a child
   span. Teams that instrument only HTTP handlers leave the DB dark — and the DB is
   usually the answer.
2. **Separate dispatch from work.** Time deserialize + routing separately from
   business logic.
3. **Watch for sync blocking on async runtimes.** A blocking `lock()` or `sleep` on
   an event-loop thread spikes latency for every in-flight request.
4. **Split "wait for resource" from "use resource".** Pool acquire vs query execute;
   lock wait vs critical section; disk queue vs disk service.

No dominant span but high wall time → CPU profile (`pprof`, `perf`, `py-spy`,
`async-profiler`).

### 4. Check system-level saturation

| Metric           | Saturation signal                                       |
| ---------------- | ------------------------------------------------------- |
| CPU              | > 80% sustained; run-queue > 2× vCPU → scheduling delay |
| Memory           | Major page faults → allocator / GC stalls               |
| Disk I/O         | `await` > 10 ms or `%util` ≈ 100% → swap or log storm   |
| Network          | rx/tx drops; TCP retransmits > 0.1%                     |
| Connections      | `ss -s` TIME_WAIT storm → ephemeral port exhaustion     |
| Steal time (VMs) | Non-trivial `st` in `top` → noisy neighbor              |
| File descriptors | Near `ulimit` → accept/connect failures and stalls      |

Add headroom before micro-optimizing. CPU-only autoscaling misses memory-pressure
latency; prefer custom metrics or p99 latency as the scaling signal.

### 5. Audit retries, timeouts, and circuit breakers

Misconfigured reliability machinery is a top cause of production tail latency:

- **Retry storm** — A → B with a 100 ms timeout while B's p50 is 110 ms. Every call
  retries, load doubles, p99 explodes. Set timeouts from dependency **p99**, add
  exponential backoff with full jitter, cap retries at ≤ 2.
- **No circuit breaker** — A keeps hammering a slow B, delaying recovery.
- **No deadline propagation** — a slow leaf holds threads across the whole graph.
- **Timeout inversion** — client timeout shorter than server work budget, so the
  client retries while the server is still working.
- **Hedged requests without cancel** — duplicate work doubles load.

### 6. Look for uncoordinated thundering herds

Cache TTL expiry or a cron at `:00` makes every replica hit the same backend at
once. Jitter TTLs (`TTL * random(0.8, 1.2)`), stagger crons, use single-flight /
distributed locks for run-once jobs, and coalesce requests on cache miss.

### 7. Confirm with controlled reproduction

Capture a representative trace and traffic mix, replay at production concurrency
(open loop if possible), inject **one** variable, and watch p99 — not the mean —
before declaring victory. Chaos tools (Toxiproxy, Chaos Mesh) validate that timeouts
and breakers behave under induced dependency latency.

## Recurring villains

| Symptom                          | Most likely                                    | Next likely                  |
| -------------------------------- | ---------------------------------------------- | ---------------------------- |
| p99 high, p50 normal             | GC / compaction / lock                         | Retry-on-timeout             |
| All latencies high, all hops     | Connection pool exhaustion                     | Network congestion           |
| Spikes every 5–15 min            | Config reload, log rotate, K8s leader election | TLS cert rotation            |
| Latency ∝ payload size           | Serialization (JSON → protobuf)                | Full table / large scans     |
| Latency after deploy, then heals | Cache cold start                               | JIT warm-up                  |
| Only first request slow          | TLS / pool init                                | Lazy singleton               |
| All services slow at once        | Shared DNS / LB / Kafka / DB                   | AZ or cloud provider issue   |
| Latency only under concurrency   | Lock contention / pool wait                    | Thread pool saturation       |
| Good traces, bad user experience | Client-side / CDN / last mile                  | Browser main-thread blocking |
| Latency rises with fan-out width | Head-of-line / sequential calls                | Shared downstream saturation |
| Cross-AZ calls suddenly slow     | AZ networking / MTU / peering                  | Mis-routed traffic           |

Nine worked examples tracing each of these from symptom to fix — plus playbooks for
async/queue-backed work, edge/CDN/RUM, and multi-tenant noisy neighbors — are in
`references/worked-examples.md`.

## Quick decision tree

```
Is there a trace for a slow request?
├─ No  → Add/fix instrumentation; stop guessing
└─ Yes → Open waterfall
         ├─ One fat span?
         │   ├─ External call fat → dependency / pool / query
         │   └─ Local span fat, no children → profile CPU / locks / GC
         ├─ Dark gaps between thin spans?
         │   └─ Queuing: threads, pools, run queue, proxy
         ├─ Children sequential but independent?
         │   └─ Parallelize
         ├─ Outbound rate ≫ inbound rate?
         │   └─ Retries / hedges / fan-out amplification
         └─ Everything fine in traces, users still slow?
             └─ Client, CDN, DNS, multiplexing, or post-response work
```

## Incident checklist

Work top-down through `references/incident-checklist.md` during an active incident.
Check a box only with evidence, not a guess. It covers observability, scoping,
timeouts and backpressure, database and cache, infrastructure, code-level, and the
"before you close" bar.

## Axioms

1. The first 90% of latency diagnosis is reading a trace waterfall.
2. Never guess. If you cannot see it in a trace, add instrumentation first.
3. Retries without backoff are a denial-of-service attack on yourself.
4. Fast p50 + slow p99 ⇒ synchronization (lock, GC, pool, queue). Slow p50 + slow
   p99 ⇒ capacity or common-path work.
5. Tracing that drops all slow/error traces is negligent. Head-sample plus tail-sample.
6. The most expensive query is the one without an index. Second place: the one whose
   plan changed after a stats refresh or `VACUUM`.
7. Pool wait ≠ query time. Confusing them wastes hours.
8. If you cannot explain the latency with data, you have not collected the right data.
9. Latency budgets are architecture. Parallelism, caching, and topology are design
   choices, not after-the-fact tuning.
10. Prove the fix on the tail. A mean that moves while p99 does not is not a win.
