---
name: latency-diagnosis
description: Use when diagnosing latency in distributed services, especially within the Pragma infrastructure (host-server + native-client). Covers the observability triad, diagnostic checklist, common culprits, examples, and best practices.
---

# Latency Diagnosis Guide

This guide outlines the standard approach for diagnosing latency in distributed services within the Pragma infrastructure and beyond.

## 1. The Observability Triad

When diagnosing latency, leverage these three pillars:

- **Distributed Tracing:** Essential for visualizing request flow. Use it to find which hop in the call chain adds the most latency.
- **Metrics:** Focus on **P99 latency** rather than averages to detect tail latency issues affecting your users.
- **Logs:** Provide context for specific requests identified as outliers in traces.

## 2. Diagnostic Checklist

1.  **Baseline Verification:** Confirm the latency is actually higher than the defined Service Level Objective (SLO).
2.  **Trace Analysis:** Inspect the end-to-end trace. Identify the span contributing the most to the total latency.
3.  **Service Health Audit:** Check metrics for the services involved (CPU saturation, Memory pressure, Disk I/O, Network I/O).
4.  **Downstream Dependency Check:** Investigate the services or data stores called by the slow span.
5.  **Infrastructure Inspection:** Check load balancer performance, network throughput, and DNS resolution times.

## 3. Common Culprits

| Issue                     | Symptom                            | Mitigation                                       |
| :------------------------ | :--------------------------------- | :----------------------------------------------- |
| **N+1 Queries**           | Many small database calls          | Batch queries into a single request.             |
| **Dependency Saturation** | Service A waits for B              | Add caching, rate limiting, or scale B.          |
| **Resource Contention**   | High GC pauses / Thread starvation | Optimize code, increase resource limits.         |
| **Lock Contention**       | High mutex wait time               | Refactor shared state, use lock-free structures. |

## 4. Examples

### N+1 Database Queries
A loop in `pragma-server` fetching a list of PTYs one by one instead of a single request.

### Dependency Saturation
A slow database query causing the `pragma-gateway` to wait, cascading latency to the client.

### Network Latency
High latency between the native client and `pragma-server` over a bridged connection.

## 5. Best Practices

- **Propagate Traces:** Ensure trace headers are passed in all requests between services.
- **Defensive Timeouts:** Set strict timeouts for all external calls.
- **Retries with Jitter:** Implement exponential backoff to prevent thundering herd problems.
- **Instrument Early:** Build observability into the service from the first line of code.
