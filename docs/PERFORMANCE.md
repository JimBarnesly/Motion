# Performance and Reliability

Initial measured targets on documented mid-range hardware: useful cold shell within 2 seconds; materially faster warm launch; no ordinary typing lag; quick indexed search below 200 ms; smooth long-page scrolling; streamed attachments; no synchronous remote work in the typing path; and deterministic recovery from interrupted writes/migrations.

Fixtures must cover 10,000 pages, 100,000 blocks, 50,000 records, deep hierarchies, dense backlink graphs, long documents, thousands of attachments, and concurrent offline operations. Reports record hardware, OS, commit, dataset seed, repetitions, percentile timings, memory, and failures. Budgets become CI regression thresholds only after representative baselines exist.

Reliability tests include process termination around transaction boundaries, migration interruption, index corruption/rebuild, disk-full/write failure, backup restoration, network denial, retry/idempotence, and later convergence testing.

`BENCHMARKS.md` and `scripts/benchmark.mjs` provide the current reproducible starting point. Results from the lightweight web/core slice are not evidence that the future SQLite/Tauri/editor stack meets release targets.
