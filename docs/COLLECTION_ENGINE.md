# Collection Engine

A collection is a versioned schema over records; each record is also a page. Property definitions and values are typed and validated at domain boundaries.

## Types and views

Initial properties: title, plain/rich text, number, checkbox, select, multi-select, status, date/range, URL, email, phone, files, and creation/modification actor/time fields. Relation, rollup, formula, person, identifier, action, location, duration, progress, and dependency extend the registry without changing stored historical types.

Views are saved configurations over common records. Configuration includes ID, collection, type, visible/property order, widths, typed filter AST, stable sorts, grouping, layout, previews, date fields, permissions, and personal/shared scope. Implement views in order: table, list, board, calendar, gallery, timeline, chart, form.

Filters use typed `AND`/`OR`/`NOT` expression trees. Sorts specify direction, null position, locale-aware comparison, and deterministic tie-breaking. Never persist raw SQL as a view filter.

Relations validate collection/record targets and reciprocal constraints. Rollups detect dependency cycles and support count variants, sum, average, min/max, earliest/latest, percent checked, and original values. Formulas use the versioned lexer/parser/AST/evaluator described in `specifications/FORMULA.md`; JavaScript `eval` is prohibited.

Current code defines collection/view/record models and a formula package. The web slice exposes editable tables; complete views, relation/rollup execution, and production query planning are not yet implemented.
