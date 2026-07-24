# Worked examples

Nine end-to-end diagnoses, each ending in the generalizable lesson. Followed by
three special cases that deserve their own playbook.

## A — Pool exhaustion behind a "slow DB" span

> **Symptom:** `POST /api/checkout` p99 = 4.2 s, p50 = 180 ms.

Trace waterfall:

| Span                 | Duration            |
| -------------------- | ------------------- |
| checkout-service     | 50 ms               |
| payment-service      | **3.8 s** (fat hop) |
| inventory-service    | 120 ms              |
| notification-service | 230 ms              |

payment-service children:

| Span          | Duration | Notes                                   |
| ------------- | -------- | --------------------------------------- |
| `authorize()` | 200 ms   | Fine                                    |
| `charge()`    | 3.6 s    | **3.5 s dark gap before first DB byte** |

Host saturation: CPU 15%, memory 40% — not compute-bound. DB pool 128/128 active →
exhausted. `SHOW FULL PROCESSLIST` shows everything in `COMMIT`, waiting on WAL flush.

**Root cause:** Payment DB WAL on shared EBS hitting IOPS burst limits under a
concurrent bulk-export job. Commits block 200–500 ms, the pool backs up, every
`charge()` queues.

**Fix:** Export from a read replica; raise IOPS; split read/write pools. p99 → ~520 ms.

**Lesson:** A fat DB span is often _waiting for a connection_, not a slow query.
Instrument pool wait separately from query execution.

## B — Retry storm from a tight timeout

> **Symptom:** `GET /search` p99 jumps 300 ms → 2.8 s after a dependency deploy.
> Error rate barely moves.

Metrics show search-service outbound calls to ranking-service at **2.1×** traffic;
ranking p50 moved 95 ms → 130 ms (still "okay"); client timeout is 100 ms; retries
are 1, no jitter.

**Mechanism:** ranking slipped past the 100 ms timeout → search cancels and retries
immediately → ranking still finishes the original work (wasted capacity) → offered
load ≈ 2× → ranking slows further → more timeouts.

**Fix:** Raise the client timeout to ≥ ranking p99 + margin (~250 ms); cap retries at
1 with full jitter; hedge only with prompt cancellation of the loser; add a circuit
breaker so sustained pain fails fast.

**Lesson:** Set timeouts from **dependency p99**, not from a round number that feels
snappy.

## C — Sequential fan-out that should be parallel

> **Symptom:** Product page p95 = 900 ms. Every dependency is fast.

```
product-page ──────────────────────── 900 ms
  ├─ catalog.get     120 ms
  ├─ pricing.get     150 ms   (starts after catalog)
  ├─ inventory.get   180 ms   (starts after pricing)
  └─ reviews.get     200 ms   (starts after inventory)
```

Wall time ≈ sum of children. Each child is fine; the composition is not.

**Fix:** Issue independent calls concurrently — wall time ≈ max(child) + overhead
(~200–250 ms).

**Lesson:** Always check whether sibling spans overlap in time. Non-overlap on
independent work is free latency.

## D — GC / allocation tail

> **Symptom:** JVM service, p50 stable at 40 ms; p99 spikes to 1–2 s every few
> minutes. Spikes align across pods.

Continuous profiler shows a high allocation rate in the JSON response builder; GC
logs show occasional old-gen pauses of 800 ms–1.5 s; the handler span contains a long
gap with no child spans.

**Fix:** Reduce hot-path allocations (reuse buffers, smaller payloads, streaming
responses); tune GC or move to a lower-pause collector; cache expensive DTO mapping.

**Lesson:** Periodic, cross-replica spikes with dark gaps and healthy dependency
spans point at runtime pauses (GC, safepoints), not the network.

## E — N+1 queries hiding as "business logic"

> **Symptom:** `GET /orders/{id}` p99 = 1.1 s after a feature that "just adds
> line-item status."

The trace shows one fat `handler` span, 1.05 s, no children. After adding DB spans:

```
handler ───────────────────────────── 1.05 s
  ├─ SELECT order              8 ms
  ├─ SELECT line_item × 42   ~20 ms each (sequential)
  └─ SELECT status × 42      ~5 ms each
```

**Root cause:** ORM lazy-load loop — 84 queries where 2 joins would do.

**Fix:** Eager-load or a single joined query; assert child-span counts in tests for
hot endpoints.

**Lesson:** Missing child spans look like "slow code." They are usually
uninstrumented I/O.

## F — Head-of-line blocking on HTTP/1.1

> **Symptom:** Mobile app feels sticky; server p99 looks fine (~80 ms).

The app opens few connections per host, many small API calls share one HTTP/1.1
connection, and one slow image or analytics call blocks subsequent API responses.

**Fix:** HTTP/2 or HTTP/3; connection coalescing; prioritize critical requests; move
non-critical work off the critical path.

**Lesson:** Client-visible latency can be multiplexing / head-of-line blocking,
invisible in per-handler server metrics.

## G — Cross-AZ tax and "random" spikes

> **Symptom:** p99 rises during evening peak, only on multi-hop checkout paths.

Same-AZ RTT ~0.5 ms vs cross-AZ ~2–5 ms (higher under congestion). The mesh
occasionally schedules checkout → payment across AZs. A fan-out of 8 sequential
cross-AZ calls adds tens of ms of pure RTT plus higher variance.

**Fix:** Zone-aware / topology-aware load balancing; keep request-scoped affinity;
budget cross-AZ only for failover.

**Lesson:** Microservices multiply RTT. Topology awareness is a latency feature, not
only a cost feature.

## H — Async path: "API is fast, users still wait"

> **Symptom:** `POST /export` returns 202 in 40 ms. Users report exports taking
> 30–90 s during business hours. Product calls it "latency."

Synchronous API spans are fine. Queue depth on `export-jobs` climbs ~50 → ~8k at
09:00, consumer lag tracks user wait time 1:1, worker CPU ~95%, producer rate exceeds
consumer drain rate.

**Root cause:** User-perceived latency is **queue wait + processing**, not HTTP
latency. The API only measures admission.

**Fix:** Scale consumers; shed or prioritize jobs; expose a job-age SLI; alert on
lag, not only HTTP p99.

**Lesson:** For async workflows, instrument **admission → start → complete** as
separate histograms. HTTP p99 alone is the wrong SLO.

## I — Sidecar / mesh tax mistaken for app regression

> **Symptom:** After enabling a service mesh, p99 +40–80 ms everywhere. App profiles
> unchanged.

Traces show two extra spans per hop (`egress proxy` + `ingress proxy`), each ~5–15 ms
at p50 and worse under connection churn; mTLS handshake spikes when idle timeouts
kill connections too aggressively; app CPU is flat while proxy CPU rises with QPS.

**Fix:** Tune idle and max connection lifetimes for keep-alive; enable connection
pooling in the mesh; consider an ambient or lighter data plane for low-budget hops;
exclude health checks from heavy filters.

**Lesson:** Every new hop in the data path is a latency budget line item. Attribute
mesh time separately from app time in dashboards.

---

# Special cases

## Async / queue-backed work

User wait = queue delay + service time.

| Signal                                   | Meaning                                       |
| ---------------------------------------- | --------------------------------------------- |
| Rising lag, stable processing time       | Under-consuming (scale or speed up workers)   |
| Stable lag, rising processing time       | Per-job work got slower                       |
| Lag spikes at cron / campaign boundaries | Burst producers; need buffering or smoothing  |
| Duplicate processing / redelivery storms | Visibility timeout too short vs work duration |

Propagate the original `traceparent` into message headers so one waterfall covers
HTTP → queue → worker → downstream.

## Edge, CDN, and real-user monitoring

Synthetic probes from one region miss last-mile and device variance.

| Source               | Blind spots                                                      |
| -------------------- | ---------------------------------------------------------------- |
| Datacenter synthetic | CDN cache misses elsewhere; mobile networks; browser main thread |
| Edge logs only       | Origin healthy but POP congested; TLS on client                  |
| RUM only             | Harder to bisect server hops; needs correlation to trace IDs     |

Pair RUM (p75/p95 TTFB, plus LCP where relevant) with origin histograms and
occasional synthetic multi-region checks. Join on `trace_id` / `x-request-id` when
the client can emit it.

## Multi-tenant noisy neighbors

One tenant's fan-out or large payloads inflate shared pool wait for everyone. Look
for latency stratified by `tenant_id` / `shard_id`, and for one tenant dominating DB
connections or queue depth.

If overall p99 is bad but p99 _excluding the top tenant_ is fine, you have a fairness
problem, not a global capacity problem. Fixes: per-tenant concurrency limits,
separate pools, or admission tokens.
