export const FORMULA_LANGUAGE_VERSION = 1 as const;
export type FormulaLanguageVersion = typeof FORMULA_LANGUAGE_VERSION;
export type FormulaScalar = null | string | number | boolean | Date;
export type FormulaType = "null" | "string" | "number" | "boolean" | "date" | "unknown";
export type FormulaErrorCode = "LEX" | "PARSE" | "TYPE" | "NAME" | "DIV_ZERO" | "CYCLE" | "VERSION";
export interface FormulaError { readonly kind: "error"; readonly code: FormulaErrorCode; readonly message: string; readonly position?: number }
export type FormulaValue = FormulaScalar | FormulaError;
export const formulaError = (code: FormulaErrorCode, message: string, position?: number): FormulaError =>
  position === undefined ? { kind: "error", code, message } : { kind: "error", code, message, position };
export const isFormulaError = (value: FormulaValue): value is FormulaError =>
  typeof value === "object" && value !== null && !(value instanceof Date) && "kind" in value && value.kind === "error";

export type UnaryOperator = "-" | "+" | "not";
export type BinaryOperator = "+" | "-" | "*" | "/" | "%" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
export type Expression =
  | { readonly kind: "literal"; readonly value: FormulaScalar; readonly valueType: Exclude<FormulaType, "unknown"> }
  | { readonly kind: "property"; readonly name: string; readonly valueType: "unknown" }
  | { readonly kind: "unary"; readonly operator: UnaryOperator; readonly operand: Expression; readonly valueType: FormulaType }
  | { readonly kind: "binary"; readonly operator: BinaryOperator; readonly left: Expression; readonly right: Expression; readonly valueType: FormulaType }
  | { readonly kind: "call"; readonly name: string; readonly arguments: readonly Expression[]; readonly valueType: FormulaType };
export interface ParsedFormula { readonly languageVersion: FormulaLanguageVersion; readonly source: string; readonly expression: Expression; readonly dependencies: readonly string[] }
