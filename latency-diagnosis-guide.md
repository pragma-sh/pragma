# Diagnosing Latency in a Distributed Service

A systematic guide for root-causing tail latency, p50/p99 degradation, and
intermittent slowdowns in microservice or mesh architectures.

Use this when a user-facing endpoint is slow, a dependency graph feels
"mysteriously sticky," or SLOs are burning and you need a repeatable path
from symptom → fat hop → root cause → fix.

---

## 1. The Mental Model

Distributed latency is not one number. It is a sum, repeated at every hop:

```
request latency ≈ Σ (queuing delay + service time + network time)
```

- **Queuing delay** — waiting for a thread, connection, lock, CPU run queue,
  or kernel backlog. Often invisible in code-level timers.
- **Service time** — actual work: CPU, serialization, DB query execution,
  business logic.
- **Network time** — RTT, TLS handshake, serialization on the wire,
  proxy hops, DNS.

You cannot fix what you cannot observe. The first step is always
**end-to-end tracing** with unique request IDs propagated through every hop
(W3C `traceparent` / Zipkin B3 / OpenTelemetry).

### Percentiles matter more than averages

| Signal | What it usually means |
|---|---|
| p50 rising | Capacity problem (under-provisioned, slow common path) |
| p99 / p999 rising, p50 flat | Tail problem: GC, locks, retries, pool waits, noisy neighbor |
| Mean ≫ median | Heavy tail or a minority of catastrophic outliers |

**Unwritten rule:** Optimize the tail first. It is almost always a
synchronization choke (lock contention, GC pause, head-of-line blocking,
thundering herd) or a config mistake (pool too small, timeout too tight,
retry storm).

### Latency vs. throughput vs. utilization

These three move together but mean different things:

| Metric | Question it answers |
|---|---|
| Latency | How long did *one* request wait? |
| Throughput | How many requests completed per second? |
| Utilization | How close is a resource to its capacity limit? |

Little's Law links them for a stable system:

```
concurrency ≈ throughput × latency
```

If latency doubles at constant throughput, concurrency (in-flight work)
doubles — pools, threads, and memory pressure follow. A latency spike that
looks "small" (200 ms → 400 ms) can silently double queue depth and tip
pools into exhaustion.

### Latency budget framing

Before diagnosing, write down the budget:

```
SLO: POST /checkout p99 < 800 ms
Budget split (example):
  edge + auth     50 ms
  checkout svc   100 ms
  payment        400 ms
  inventory      150 ms
  notification   100 ms
```

Any hop burning more than its budget is a candidate. If every hop is under
budget but the sum exceeds the SLO, you have **serialization of work that
could be parallel** — or hidden gaps between spans (queuing).

### Client, server, and "user" latency are different clocks

| Measurement point | What it includes |
|---|---|
| Browser / mobile TTFB | DNS + TCP + TLS + edge + origin queue + first byte |
| Edge / LB latency | Origin queue + service time (no client RTT) |
| Server handler timer | Often *excludes* accept-queue wait (common blind spot) |
| Distributed trace wall | Sum of spans + gaps; misses client-side JS / CDN if not instrumented |

A "fast" server histogram with unhappy users usually means the pain is
**before the handler starts** (LB queue, accept backlog) or **after the
response leaves** (CDN, last mile, client main thread).

---

## 2. Measurement Pitfalls (Read Before You Trust the Graph)

Bad measurement produces confident wrong answers. Check these first.

### Averaging percentiles is wrong

`avg(p99)` across pods or time buckets **underestimates** the true p99.
Aggregate raw histograms (or use HDR / OpenTelemetry exponential histograms)
and compute percentiles from the merged distribution.

### Coordinated omission

Load generators that wait for each response before sending the next
**hide tail latency**. Under load, slow requests suppress subsequent
arrivals, so the measured p99 looks better than production.

**Fix:** Use a closed-loop vs open-loop consciously. Prefer arrival-rate
driven tests (open loop / constant arrival) with scheduled start times,
and record *intended* issue time vs completion time.

### Sampling bias

Head-based sampling at 1 % often drops the exact slow traces you need.
Prefer:

1. Always keep errors and traces above a latency threshold (tail sampling).
2. Or head-sample aggressively but promote slow/error traces before discard.

### Clock skew

If service A and B disagree by 200 ms, waterfalls lie. NTP drift >
~50–100 ms makes cross-service gap analysis unreliable. Prefer parent-based
duration (child reports its own wall time) over comparing absolute clocks
across hosts.

### Histogram bucket resolution

Prometheus `le="0.1", "0.25", "0.5", "1"` cannot distinguish 110 ms from
240 ms. For SLO work near a budget edge, use finer buckets around the
target (e.g. 50 ms steps near 800 ms).

---

## 3. The Standard Approach (Top-Down)

### Step 1 — Establish the baseline

Before changing anything, know the numbers:

- p50, p95, p99, p999 latency for every internal RPC (not just the edge).
- Error rate by status code and endpoint (4xx vs 5xx vs timeouts).
- Throughput (req/s) at the observed latency — is the system saturated?
- Client-side vs server-side clock skew (< 10 ms fine; > 100 ms means
  waterfalls lie).
- When it started: deploy? traffic spike? dependency incident? cron window?
- Blast radius: one shard / AZ / customer cohort, or everywhere?

**Tools:** Prometheus + Grafana (aggregate), Jaeger/Zipkin/OTel (trace-level),
`curl -w '@latency-format.txt'` (ad-hoc).

Example `curl` format file:

```
time_namelookup:  %{time_namelookup}\n
time_connect:     %{time_connect}\n
time_appconnect:  %{time_appconnect}\n
time_starttransfer: %{time_starttransfer}\n
time_total:       %{time_total}\n
```

### Step 2 — Identify the fat hop

In the tracing UI, sort traces by total duration descending. Open the
slowest. The waterfall should show which span dominates.

| Pattern | Likely cause |
|---|---|
| One span ≈ 90 % of wall time | That service is the bottleneck |
| All spans slow; idle gaps between them | Network, TLS redo, or proxy buffering |
| Thin spans, thick dark gap between them | Queuing (pool wait, thread starvation, backlog) |
| Periodic spikes across unrelated traces | GC, cron/admin lock, noisy-neighbor VM |
| Fan-out: many sibling spans, wall ≈ slowest child | Parallel path OK; slowest sibling is the issue |
| Fan-out: wall ≈ sum of children | Accidental sequential calls that should be parallel |
| Span starts late relative to parent | Accept queue / scheduler delay before handler |

**Fix reflex:** Fat hop → drill into that service (Step 3). Gap between
services → connection pools (keep-alive, max connections, idle timeout)
and TLS session reuse.

### Step 3 — Drill into the fat-hop service

Inside the slow service, apply the same waterfall at code level:

1. **Instrument every external call** (DB, cache, HTTP, disk, queue) as a
   child span. Teams that only instrument HTTP handlers leave the DB dark —
   and the DB is usually the answer.
2. **Separate dispatch from work.** Time deserialize + routing separately
   from business logic. Large JSON payloads and reflection-heavy serializers
   show up here.
3. **Watch for sync blocking on async runtimes.** `sleep` / blocking `lock()`
   on an event-loop thread spikes latency for every in-flight request.
4. **Split "wait for resource" from "use resource".** Pool acquire vs query
   execute; lock wait vs critical section; disk queue vs disk service.

**Fix reflex:** Fat DB span → query plan, missing index, N+1, or pool wait
(query fast, connection wait long). No dominant span but high wall time →
CPU profile (`pprof`, `perf`, `py-spy`, `async-profiler`).

### Step 4 — Check system-level saturation

Perfect code still slows when the machine is overcommitted:

| Metric | Saturation signal |
|---|---|
| CPU | > 80 % sustained; run-queue > 2× vCPU → scheduling delay |
| Memory | Major page faults → allocator / GC stalls |
| Disk I/O | `await` > 10 ms or `%util` ≈ 100 % → swap or log storm |
| Network | rx/tx drops; TCP retransmits > 0.1 % |
| Connections | `ss -s` TIME_WAIT storm → ephemeral port exhaustion |
| Steal time (VMs) | Non-trivial `st` in `top` → noisy neighbor |
| File descriptors | Near `ulimit` → accept/connect failures and stalls |

**Fix reflex:** Add headroom (scale up/out) before micro-optimizing.
CPU-only autoscaling misses memory-pressure latency; prefer custom metrics
or p99 latency as a scaling signal.

### Step 5 — Retries, timeouts, and circuit breakers

Misconfigured reliability machinery is a top cause of production tail latency:

- **Retry storm:** A → B with 100 ms timeout; B p50 is 110 ms. Every call
  retries once → load doubles → p99 explodes. Fix: timeouts above p99, not
  p50; exponential backoff with full jitter; cap retries (≤ 2).
- **No circuit breaker:** When B is slow, A keeps hammering → recovery
  delayed. Fix: fail fast after N consecutive failures; half-open probes.
- **No deadline propagation:** A → B → C with no timeouts. A slow C holds
  threads/goroutines across the graph → cascading latency or OOM.
- **Timeout inversion:** Client timeout shorter than server work budget →
  client retries while server still works → amplified load.
- **Hedged requests without cancel:** Duplicate work doubles load unless
  the loser is cancelled promptly.

### Step 6 — Uncoordinated thundering herds

When a cache TTL expires or a cron fires, every replica can hit the same
backend at once:

- Cache stampede → DB spike → latency spike → more misses.
- Cron at `:00` → synchronized log rotate / compaction → I/O pause everywhere.

**Fix:** Jitter TTLs (`TTL * random(0.8, 1.2)`), stagger crons, single-flight /
`sync.Once` / distributed lock for "run once" jobs, request coalescing on
cache miss.

### Step 7 — Confirm with controlled reproduction

Once you have a hypothesis, reproduce under load:

1. Capture a representative trace ID and traffic mix.
2. Replay with k6/vegeta at production concurrency (open loop if possible).
3. Inject one variable (pool size, timeout, index, payload size).
4. Watch p99 — not only mean — before declaring victory.

Chaos tools (Toxiproxy, Chaos Mesh) are useful to validate that timeouts
and breakers behave under induced dependency latency.

---

## 4. Recurring Villains (Cheat Sheet)

| Symptom | Most likely | Next likely |
|---|---|---|
| p99 high, p50 normal | GC / compaction / lock | Retry-on-timeout |
| All latencies high, all hops | Connection pool exhaustion | Network congestion |
| Spikes every 5–15 min | Config reload, log rotate, K8s leader election | TLS cert rotation |
| Latency ∝ payload size | Serialization (JSON → protobuf) | Full table / large scans |
| Latency after deploy, then heals | Cache cold start | JIT warm-up |
| Only first request slow | TLS / pool init | Lazy singleton |
| All services slow at once | Shared DNS / LB / Kafka / DB | AZ or cloud provider issue |
| Latency only under concurrency | Lock contention / pool wait | Thread pool saturation |
| Good traces, bad user experience | Client-side / CDN / last mile | Browser main-thread blocking |
| Latency rises with fan-out width | Head-of-line / sequential calls | Shared downstream saturation |
| Cross-AZ calls suddenly slow | AZ networking / MTU / peering | Mis-routed traffic |

---

## 5. Worked Examples

### Example A — Pool exhaustion behind a "slow DB" span

> **Symptom:** `POST /api/checkout` p99 = 4.2 s. p50 = 180 ms.

**Trace waterfall:**

| Span | Duration |
|---|---|
| checkout-service | 50 ms |
| payment-service | **3.8 s** (fat hop) |
| inventory-service | 120 ms |
| notification-service | 230 ms |

**payment-service children:**

| Span | Duration | Notes |
|---|---|---|
| `authorize()` | 200 ms | Fine |
| `charge()` | 3.6 s | **3.5 s dark gap before first DB byte** |

**Host saturation:**

- CPU 15 %, memory 40 % — not compute-bound
- DB pool: 128/128 active → **exhausted**
- `SHOW FULL PROCESSLIST`: all in `COMMIT`, waiting on WAL flush

**Root cause:** Payment DB WAL on shared EBS hitting IOPS burst limits under
a concurrent bulk-export job. Commits block 200–500 ms → pool backs up →
every `charge()` queues.

**Fix:** Export to read replica; raise IOPS; split read/write pools.
p99 → ~520 ms.

**Lesson:** A fat DB span is often *waiting for a connection*, not a slow
query. Instrument pool wait separately from query execution.

---

### Example B — Retry storm from a tight timeout

> **Symptom:** `GET /search` p99 jumps from 300 ms to 2.8 s after a
> dependency deploy. Error rate barely moves.

**What metrics show:**

- search-service outbound calls to ranking-service: request rate **2.1×**
  traffic
- ranking-service p50: 95 ms → 130 ms (still "okay")
- Client timeout on search → ranking: **100 ms**
- Retries: 1 retry, no jitter

**Mechanism:**

1. Ranking slowed slightly past the 100 ms client timeout.
2. Search cancels and retries immediately.
3. Ranking still finishes the original work → wasted capacity.
4. Offered load ≈ 2× → ranking slows further → more timeouts.

**Fix:**

- Raise client timeout to ≥ ranking p99 + margin (e.g. 250 ms).
- Cap retries at 1 with full jitter; prefer hedged requests only with
  cancellation of the loser.
- Add a circuit breaker so sustained ranking pain fails fast.

**Lesson:** Timeout must be set from **dependency p99**, not from a round
number that "feels snappy."

---

### Example C — Sequential fan-out that should be parallel

> **Symptom:** Product page p95 = 900 ms. Each dependency is fast.

**Trace:**

```
product-page ──────────────────────── 900 ms
  ├─ catalog.get     120 ms
  ├─ pricing.get     150 ms   (starts after catalog)
  ├─ inventory.get   180 ms   (starts after pricing)
  └─ reviews.get     200 ms   (starts after inventory)
```

Wall time ≈ sum of children. Each child is fine; the composition is not.

**Fix:** Issue independent calls concurrently; wall time ≈ max(child) +
overhead (~200–250 ms).

**Lesson:** Always check whether sibling spans overlap in time. Non-overlap
on independent work is free latency.

---

### Example D — GC / allocation tail

> **Symptom:** JVM service: p50 stable at 40 ms; p99 spikes to 1–2 s every
> few minutes. Spikes align across pods.

**Evidence:**

- Continuous profiler: allocation rate high in JSON response builder
- GC logs: young GC mostly fine; occasional old-gen pause 800 ms–1.5 s
- Trace: handler span includes long "gap" with no child spans

**Fix:** Reduce allocations on hot path (reuse buffers, smaller payloads,
streaming responses); tune GC or move to a lower-pause collector; cache
expensive DTO mapping.

**Lesson:** Periodic, cross-replica spikes with dark gaps and healthy
dependency spans → look at runtime pauses (GC, safepoints), not the network.

---

### Example E — N+1 queries hiding as "business logic"

> **Symptom:** `GET /orders/{id}` p99 = 1.1 s after a feature ships that
> "just adds line-item status."

**Trace (bad instrumentation):** one fat `handler` span, 1.05 s, no children.

**After adding DB spans:**

```
handler ───────────────────────────── 1.05 s
  ├─ SELECT order              8 ms
  ├─ SELECT line_item × 42   ~20 ms each (sequential)
  └─ SELECT status × 42      ~5 ms each
```

**Root cause:** ORM lazy-load loop — 84 queries where 2 joins would do.

**Fix:** Eager-load / single joined query; assert child-span count in tests
for hot endpoints.

**Lesson:** Missing child spans look like "slow code." They are often
uninstrumented I/O.

---

### Example F — Head-of-line blocking on HTTP/1.1

> **Symptom:** Mobile app feels sticky; server p99 looks fine (~80 ms).

**Evidence:**

- App opens few connections per host (browser/mobile limits).
- Many small API calls share one HTTP/1.1 connection.
- One slow image / analytics call blocks subsequent API responses.

**Fix:** HTTP/2 or HTTP/3; connection coalescing; prioritize critical
requests; move non-critical work off the critical path.

**Lesson:** Client-visible latency can be multiplexing / HOL, invisible in
per-handler server metrics.

---

### Example G — Cross-AZ tax and "random" spikes

> **Symptom:** p99 rises during evening peak; only multi-hop checkout paths.

**Evidence:**

- Same-AZ RTT ~0.5 ms; cross-AZ ~2–5 ms (or higher under congestion).
- Checkout → payment occasionally scheduled across AZs by the mesh.
- Fan-out of 8 sequential cross-AZ calls adds tens of ms of pure RTT,
  plus higher variance.

**Fix:** Zone-aware routing / topology-aware load balancing; keep
request-scoped affinity; budget cross-AZ only for failover.

**Lesson:** Microservices multiply RTT. Topology awareness is a latency
feature, not only a cost feature.

---

### Example H — Async path: "API is fast, users still wait"

> **Symptom:** `POST /export` returns 202 in 40 ms. Users report exports
> taking 30–90 s during business hours. Product calls it "latency."

**Evidence:**

- Synchronous API spans are fine.
- Queue depth on `export-jobs` climbs from ~50 → ~8k at 09:00.
- Consumer lag (newest - oldest unacked) tracks user wait time 1:1.
- Worker CPU ~95 %; producer rate > consumer drain rate.

**Root cause:** User-perceived latency is **queue wait + processing**, not
HTTP latency. The API only measures admission.

**Fix:** Scale consumers; shed / prioritize jobs; expose job-age SLI
(`time_to_first_byte_of_result`); alert on lag, not only HTTP p99.

**Lesson:** For async workflows, instrument **admission → start → complete**
as separate histograms. HTTP p99 alone is the wrong SLO.

---

### Example I — Sidecar / mesh tax mistaken for app regression

> **Symptom:** After enabling a service mesh, p99 +40–80 ms everywhere.
> App profiles unchanged.

**Evidence:**

- Trace shows two extra spans per hop: `egress proxy` + `ingress proxy`.
- Each adds ~5–15 ms at p50; more under connection churn.
- mTLS handshake spikes when idle timeouts kill connections too aggressively.
- App CPU flat; proxy CPU rises with QPS.

**Fix:** Tune idle / max connection lifetimes for keep-alive; enable
connection pooling in the mesh; consider ambient / lighter data plane for
low-budget hops; exclude health checks from heavy filters.

**Lesson:** Every new hop in the data path is a latency budget line item.
Attribute mesh time separately from app time in dashboards.

---

## 6. Special Cases Worth Separate Playbooks

### Async / queue-backed work

User wait = queue delay + service time. Diagnose with:

| Signal | Meaning |
|---|---|
| Rising lag, stable processing time | Under-consuming (scale / speed workers) |
| Stable lag, rising processing time | Per-job work got slower |
| Lag spikes at cron / campaign boundaries | Burst producers; need buffering or smoothing |
| Duplicate processing / redelivery storms | Visibility timeout too short vs work duration |

Propagate the original `traceparent` into message headers so a single
waterfall covers HTTP → queue → worker → downstream.

### Edge, CDN, and real-user monitoring (RUM)

Synthetic probes from one region miss last-mile and device variance.

| Source | Blind spots |
|---|---|
| Datacenter synthetic | CDN cache misses elsewhere; mobile networks; browser main thread |
| Edge logs only | Origin-healthy but POP-congested; TLS on client |
| RUM only | Harder to bisect server hops; need correlation to trace IDs |

**Practice:** Pair RUM (p75/p95 TTFB + LCP where relevant) with origin
histograms and occasional synthetic multi-region checks. Join on
`trace_id` / `x-request-id` when the client can emit it.

### Multi-tenant noisy neighbors

One tenant’s fan-out or large payloads can inflate shared pool wait for
everyone. Look for:

- Latency stratified by `tenant_id` / `shard_id`
- One tenant dominating DB connections or queue depth
- Fairness controls: per-tenant concurrency limits, separate pools, or
  admission tokens

If overall p99 is bad but p99 *excluding top tenant* is fine, you have a
fairness problem, not a global capacity problem.

---

## 7. Incident Checklist

Work top-down. Check a box only when you have evidence, not a guess.

### Observability

- [ ] Unique trace ID on every request (`traceparent` / `x-request-id`)
- [ ] Trace ID propagated across all hops (incl. async workers / queues)
- [ ] Child spans for DB, cache, HTTP, disk, and queue operations
- [ ] Pool acquire / lock wait instrumented separately from work
- [ ] Span timestamps from a monotonic clock where possible
- [ ] Adaptive / tail sampling: keep 100 % of errors and slow traces
- [ ] Metrics: p50/p95/p99 (and ideally p999) per endpoint and per downstream
- [ ] Histograms aggregated correctly (no averaging of percentiles)
- [ ] RED/USE dashboards for the fat-hop service (Rate, Errors, Duration /
      Utilization, Saturation, Errors)

### Scope the incident

- [ ] Confirm client vs edge vs origin (CDN/browser ruled in or out)
- [ ] Note start time; correlate with deploys, traffic, cron, dependency status
- [ ] Separate "slow successful" from "timeout / 5xx" (different playbooks)
- [ ] Compare one AZ / region / shard vs others (blast radius)
- [ ] Compare canary / new version vs baseline if a deploy is involved
- [ ] Confirm whether throughput rose, fell, or stayed flat with latency

### Timeouts & backpressure

- [ ] Every outbound call has an explicit client timeout
- [ ] Timeouts decrease toward the leaf (no inversion)
- [ ] Server cancels work when the client deadline expires (context/deadline)
- [ ] Retries ≤ 2, exponential backoff, full jitter
- [ ] Circuit breakers (or equivalent) on critical dependencies
- [ ] Connection pools bounded; abort/fail-fast when exhausted (no unbounded queue)
- [ ] Pool in-use vs max monitored and alerted
- [ ] Load shed / admission control when queues exceed SLO budget

### Database & cache

- [ ] Slow query log on (threshold ≤ 100 ms, or tighter for your SLO)
- [ ] Hot queries reviewed with `EXPLAIN ANALYZE` / equivalent
- [ ] No N+1 on hot paths (verify via child-span counts)
- [ ] Pool wait time instrumented separately from query time
- [ ] Cache TTLs jittered; stampede protections (single-flight / locks)
- [ ] Cache hit rate / miss rate monitored
- [ ] Lock waits / deadlocks checked during the window

### Infrastructure

- [ ] CPU, memory, disk, network saturation checked on fat-hop hosts
- [ ] VM steal time checked (`st` / `stolen`)
- [ ] TCP retransmit rate < ~0.1 %
- [ ] DNS cached / not resolved per request on hot path
- [ ] TLS session reuse / termination offload considered
- [ ] Logging async; request path never blocks on disk flush
- [ ] No noisy neighbor on shared disks, NICs, or DB instances
- [ ] Ephemeral ports / `TIME_WAIT` / fd limits checked under peak concurrency
- [ ] Zone-aware routing verified for multi-hop paths

### Code-level

- [ ] Hot path free of accidental global locks / coarse mutexes
- [ ] Serialization profiled for large payloads
- [ ] Allocation / GC pressure reviewed if runtime is managed
- [ ] No `sleep` / blocking I/O on event-loop or limited worker threads
- [ ] Independent outbound calls issued concurrently where safe
- [ ] No accidental sync I/O in "async" handlers

### Before you close

- [ ] Root cause named with evidence (trace ID + metric + host signal)
- [ ] Fix verified against p99 (not only p50) under representative load
- [ ] Guardrail added (alert, pool metric, timeout test, load test)
- [ ] Runbook / this checklist updated if a new villain appeared
- [ ] SLO burn rate / error budget impact documented for the postmortem

---

## 8. Tools Reference

| Layer | Tool | What it tells you |
|---|---|---|
| Distributed traces | Jaeger, Zipkin, OpenTelemetry | Per-span latency, dependency graph, waterfall |
| Metrics | Prometheus + Grafana | Aggregate percentiles, errors, saturation |
| Continuous profiling | Parca, Pyroscope, Google Profiler | Always-on CPU/memory correlated with latency |
| CPU / memory (ad-hoc) | `pprof`, `async-profiler`, `py-spy`, `perf` | Hot functions, locks, GC |
| Network | `tcpdump`, Wireshark, `mtr`, `ss`, `sar` | Retransmits, RTT, drops, TIME_WAIT |
| DB | `EXPLAIN ANALYZE`, `pg_stat_statements`, processlist | Plans, indexes, lock waits |
| Linux | `top`/`htop`, `iostat`, `vmstat`, `dmesg` | Steal, I/O await, OOM, kernel errors |
| Chaos | Toxiproxy, Chaos Mesh, Gremlin | Inject latency; validate timeouts/breakers |
| Load | k6, vegeta, ghz | Reproduce tail under controlled concurrency |

---

## 9. Quick Decision Tree

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

---

## 10. Axioms

1. **The first 90 % of latency diagnosis is reading a trace waterfall.**
   The remaining 10 % is proving why that one span is slow.
2. **Never guess.** If you cannot see it in a trace, add instrumentation
   before speculating.
3. **Retries without backoff are a denial-of-service attack on yourself.**
4. **Fast p50 + slow p99 ⇒ synchronization** (lock, GC, pool, queue).
   **Slow p50 + slow p99 ⇒ capacity or common-path work.**
5. **Tracing without sampling is too expensive; tracing that drops all
   slow/error traces is negligent.** Prefer head-based sampling plus
   tail sampling for high latency and errors.
6. **The most expensive query is the one without an index.** Second place:
   the one whose plan changed after stats refresh / `VACUUM`.
7. **Instrument pool wait ≠ query time.** Confusing them wastes hours.
8. **If you cannot explain the latency with data, you have not collected
   the right data.**
9. **Latency budgets are architecture.** Parallelism, caching, and topology
   are design choices — not after-the-fact tuning.
10. **Prove the fix on the tail.** A mean that moves while p99 does not is
    not a win for user-facing SLOs.
