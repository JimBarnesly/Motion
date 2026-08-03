# Formula and Rollup Specification

Status: design contract; formula and rollup execution are not yet implemented.

## Rollups

A rollup definition identifies a relation property, a target property, aggregation, result type, and explicit treatment of null, unavailable, and tombstoned targets. Initial aggregations are count, count values, count unique, sum, average, minimum, maximum, earliest date, latest date, percent checked, and show original values. Results are derived and rebuildable; source values remain canonical.

Relation and rollup dependencies form a directed graph. Evaluation rejects cycles and bounded traversal prevents uncontrolled recursion. Cross-collection references are validated against stable collection/property IDs and compatible types. Deleted records remain distinguishable from missing values.

## Formula language

Formula definitions persist `source`, `languageVersion`, declared result type when known, and stable property references. JavaScript `eval`, host-language execution, network access, filesystem access, time-zone-dependent implicit behavior, and nondeterministic functions are forbidden.

The implementation pipeline is lexer → parser → versioned typed AST → type checker → evaluator. It supports explicit null semantics; error values; numeric, string, Boolean, and date operations; collection-property references; and deterministic locale/time-zone inputs supplied by the workspace context. Parse, type, missing-reference, cycle, divide-by-zero, and evaluation failures are values visible to the UI, not exceptions that corrupt a transaction.

Dependencies are extracted from the AST into a graph. A change invalidates only affected formula and rollup results. Cycles report the complete dependency path and do not partially publish results. Evaluation has depth, operation-count, and output-size limits.

## Compatibility and tests

Language versions are immutable interpretation contracts. A newer writer may migrate source only through an explicit recorded migration; older clients preserve unsupported formulas without rewriting them. Required fixtures cover lexing/parsing, precedence, type errors, nulls, dates/time zones, Unicode strings, numeric boundaries, stable property-ID references, dependency invalidation, direct/indirect cycles, relation cycles, deterministic serialization, and property-based evaluator tests.
