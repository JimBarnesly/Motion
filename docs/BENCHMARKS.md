# Benchmarks

Run `npm run benchmark` after a build. The default reproducible fixture contains
10,000 pages and 100,000 blocks. The command reports index time, quick-search
latency, integrity status, and whether the current 200 ms quick-search target is
met on the current host.

Override fixture size with `MOTION_BENCH_PAGES` and `MOTION_BENCH_BLOCKS`.
Benchmark output is evidence for this implementation only; it is not a desktop
startup or SQLite FTS5 measurement. Those require the packaged Tauri runtime and
representative Ubuntu hardware.

## Pages and tables

Run:

```sh
npm run benchmark:pages-tables -- 100
npm run benchmark:pages-tables -- 1000
npm run benchmark:pages-tables -- 5000
```

The fixture contains nested pages, a typed Jobs database, saved filtering and
multi-sort, record-page block content, and a stable-ID page link. Measurements
on the development host on 2026-08-09:

| Records | Open | Filter | Sort | Edit | Heap delta |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 7.8 ms | 1.7 ms | 17.7 ms | 0.32 ms | 0.18 MiB |
| 1,000 | 66.8 ms | 25.5 ms | 39.8 ms | 0.59 ms | 3.67 MiB |
| 5,000 | 104.9 ms | 310.0 ms | 335.8 ms | 0.47 ms | 17.93 MiB |

These measure fixture construction followed by in-process canonical open,
filter, sort, and record-property edit. They are not packaged desktop paint
times. The table UI limits rendered results to 500 rows, avoiding thousands of
unnecessary DOM rows; windowed scrolling remains future work.
