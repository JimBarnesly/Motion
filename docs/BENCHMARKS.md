# Benchmarks

Run `npm run benchmark` after a build. The default reproducible fixture contains
10,000 pages and 100,000 blocks. The command reports index time, quick-search
latency, integrity status, and whether the current 200 ms quick-search target is
met on the current host.

Override fixture size with `MOTION_BENCH_PAGES` and `MOTION_BENCH_BLOCKS`.
Benchmark output is evidence for this implementation only; it is not a desktop
startup or SQLite FTS5 measurement. Those require the packaged Tauri runtime and
representative Ubuntu hardware.
