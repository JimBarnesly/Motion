import { lex, type Token } from "./lexer.js";
import { FORMULA_LANGUAGE_VERSION, type BinaryOperator, type Expression, type FormulaType, type ParsedFormula } from "./types.js";
const precedence: Record<string, number> = { or:1, and:2, "=":3, "!=":3, "<":4, "<=":4, ">":4, ">=":4, "+":5, "-":5, "*":6, "/":6, "%":6 };
const binaryType = (op: string): FormulaType => ["=","!=","<","<=",">",">=","and","or"].includes(op) ? "boolean" : "unknown";
export function parseFormula(source: string, languageVersion: number = FORMULA_LANGUAGE_VERSION): ParsedFormula {
  if (languageVersion !== FORMULA_LANGUAGE_VERSION) throw new Error(`Unsupported formula language version ${languageVersion}`);
  const tokens = lex(source); let at = 0; const peek = () => tokens[at]!; const take = () => tokens[at++]!;
  const expression = (min = 0): Expression => { let left = prefix(); while (true) { const t = peek(); const op = t.kind === "operator" ? t.text : t.kind === "identifier" && ["and","or"].includes(t.text.toLowerCase()) ? t.text.toLowerCase() : ""; const p = precedence[op] ?? 0; if (!op || p < min) break; take(); const right = expression(p + 1); left = {kind:"binary",operator:op as BinaryOperator,left,right,valueType:binaryType(op)}; } return left; };
  const prefix = (): Expression => { const t = take();
    if (t.kind === "number") return {kind:"literal",value:t.value as number,valueType:"number"};
    if (t.kind === "string") return {kind:"literal",value:t.value as string,valueType:"string"};
    if (t.kind === "property") return {kind:"property",name:t.value as string,valueType:"unknown"};
    if ((t.kind === "operator" && ["-","+"].includes(t.text)) || (t.kind === "identifier" && t.text.toLowerCase() === "not")) { const operator = t.text.toLowerCase() as "+"|"-"|"not"; return {kind:"unary",operator,operand:expression(7),valueType:operator === "not" ? "boolean" : "number"}; }
    if (t.kind === "identifier") { const name = t.text.toLowerCase(); if (["true","false","null"].includes(name)) return name === "null" ? {kind:"literal",value:null,valueType:"null"} : {kind:"literal",value:name === "true",valueType:"boolean"}; if (peek().kind !== "lparen") throw new SyntaxError(`Unknown identifier '${t.text}' at ${t.position}`); take(); const args: Expression[] = []; if (peek().kind !== "rparen") { do { args.push(expression()); if (peek().kind !== "comma") break; take(); } while (true); } if (take().kind !== "rparen") throw new SyntaxError(`Expected ')' at ${peek().position}`); return {kind:"call",name:name.toUpperCase(),arguments:args,valueType:"unknown"}; }
    if (t.kind === "lparen") { const result = expression(); if (take().kind !== "rparen") throw new SyntaxError(`Expected ')' at ${peek().position}`); return result; }
    throw new SyntaxError(`Expected expression at ${t.position}`);
  };
  const root = expression(); if (peek().kind !== "eof") throw new SyntaxError(`Unexpected '${peek().text}' at ${peek().position}`);
  const deps = new Set<string>(); const visit = (node: Expression): void => { if (node.kind === "property") deps.add(node.name); else if (node.kind === "binary") { visit(node.left); visit(node.right); } else if (node.kind === "unary") visit(node.operand); else if (node.kind === "call") node.arguments.forEach(visit); }; visit(root);
  return {languageVersion:FORMULA_LANGUAGE_VERSION,source,expression:root,dependencies:[...deps].sort()};
}
