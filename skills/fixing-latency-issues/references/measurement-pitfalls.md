# Measurement pitfalls and tools

Bad measurement produces confident wrong answers. Check these before trusting any
latency graph.

## Averaging percentiles is wrong

`avg(p99)` across pods or time buckets **underestimates** the true p99. Aggregate
raw histograms (HDR, or OpenTelemetry exponential histograms) and compute
percentiles from the merged distribution.

## Coordinated omission

Load generators that wait for each response before sending the next **hide tail
latency**: under load, slow requests suppress subsequent arrivals, so the measured
p99 looks better than production.

Choose closed-loop vs open-loop consciously. Prefer arrival-rate driven tests (open
loop, constant arrival) with scheduled start times, and record _intended_ issue time
alongside completion time.

## Sampling bias

Head-based sampling at 1% often drops the exact slow traces you need. Either:

1. Always keep errors and traces above a latency threshold (tail sampling), or
2. Head-sample aggressively but promote slow/error traces before discard.

## Clock skew

If service A and B disagree by 200 ms, waterfalls lie. NTP drift beyond ~50–100 ms
makes cross-service gap analysis unreliable. Prefer parent-based duration (each
child reports its own wall time) over comparing absolute clocks across hosts.

## Histogram bucket resolution

Prometheus buckets at `le="0.1", "0.25", "0.5", "1"` cannot distinguish 110 ms from
240 ms. For SLO work near a budget edge, use finer buckets around the target — e.g.
50 ms steps near 800 ms.

## Measurement points include different things

| Measurement point      | What it includes                                                     |
| ---------------------- | -------------------------------------------------------------------- |
| Browser / mobile TTFB  | DNS + TCP + TLS + edge + origin queue + first byte                   |
| Edge / LB latency      | Origin queue + service time (no client RTT)                          |
| Server handler timer   | Often _excludes_ accept-queue wait (common blind spot)               |
| Distributed trace wall | Sum of spans + gaps; misses client-side JS / CDN if not instrumented |

## Ad-hoc curl timing

```
time_namelookup:  %{time_namelookup}\n
time_connect:     %{time_connect}\n
time_appconnect:  %{time_appconnect}\n
time_starttransfer: %{time_starttransfer}\n
time_total:       %{time_total}\n
```

Save as `latency-format.txt`, then `curl -w '@latency-format.txt' -o /dev/null -s <url>`.

## Tools reference

| Layer                 | Tool                                                 | What it tells you                             |
| --------------------- | ---------------------------------------------------- | --------------------------------------------- |
| Distributed traces    | Jaeger, Zipkin, OpenTelemetry                        | Per-span latency, dependency graph, waterfall |
| Metrics               | Prometheus + Grafana                                 | Aggregate percentiles, errors, saturation     |
| Continuous profiling  | Parca, Pyroscope, Google Profiler                    | Always-on CPU/memory correlated with latency  |
| CPU / memory (ad-hoc) | `pprof`, `async-profiler`, `py-spy`, `perf`          | Hot functions, locks, GC                      |
| Network               | `tcpdump`, Wireshark, `mtr`, `ss`, `sar`             | Retransmits, RTT, drops, TIME_WAIT            |
| DB                    | `EXPLAIN ANALYZE`, `pg_stat_statements`, processlist | Plans, indexes, lock waits                    |
| Linux                 | `top`/`htop`, `iostat`, `vmstat`, `dmesg`            | Steal, I/O await, OOM, kernel errors          |
| Chaos                 | Toxiproxy, Chaos Mesh, Gremlin                       | Inject latency; validate timeouts/breakers    |
| Load                  | k6, vegeta, ghz                                      | Reproduce tail under controlled concurrency   |
