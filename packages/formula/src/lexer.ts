export type TokenKind = "number" | "string" | "identifier" | "property" | "operator" | "lparen" | "rparen" | "comma" | "eof";
export interface Token { kind: TokenKind; text: string; position: number; value?: string | number }

export function lex(source: string): Token[] {
  const tokens: Token[] = []; let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "[") { const start = i++; let name = ""; while (i < source.length && source[i] !== "]") name += source[i++]!; if (source[i] !== "]") throw new SyntaxError(`Unclosed property at ${start}`); i++; tokens.push({ kind: "property", text: source.slice(start, i), value: name.trim(), position: start }); continue; }
    if (c === "\"" || c === "'") { const start = i++; const quote = c; let value = ""; while (i < source.length && source[i] !== quote) { if (source[i] === "\\") { i++; const escaped = source[i]; if (escaped === undefined) throw new SyntaxError(`Unclosed string at ${start}`); value += ({ n: "\n", r: "\r", t: "\t" } as Record<string,string>)[escaped] ?? escaped; i++; } else value += source[i++]!; } if (source[i] !== quote) throw new SyntaxError(`Unclosed string at ${start}`); i++; tokens.push({ kind: "string", text: source.slice(start, i), value, position: start }); continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) { const start = i; while (/[0-9]/.test(source[i] ?? "")) i++; if (source[i] === ".") { i++; while (/[0-9]/.test(source[i] ?? "")) i++; } const text = source.slice(start, i); tokens.push({ kind: "number", text, value: Number(text), position: start }); continue; }
    if (/[A-Za-z_]/.test(c)) { const start = i++; while (/[A-Za-z0-9_]/.test(source[i] ?? "")) i++; const text = source.slice(start, i); tokens.push({ kind: "identifier", text, position: start }); continue; }
    if (c === "(") { tokens.push({kind:"lparen",text:c,position:i++}); continue; } if (c === ")") { tokens.push({kind:"rparen",text:c,position:i++}); continue; } if (c === ",") { tokens.push({kind:"comma",text:c,position:i++}); continue; }
    const two = source.slice(i, i + 2); if (["!=", "<=", ">="].includes(two)) { tokens.push({kind:"operator",text:two,position:i}); i += 2; continue; } if ("+-*/%=<>".includes(c)) { tokens.push({kind:"operator",text:c,position:i++}); continue; }
    throw new SyntaxError(`Unexpected character '${c}' at ${i}`);
  }
  tokens.push({kind:"eof",text:"",position:i}); return tokens;
}
