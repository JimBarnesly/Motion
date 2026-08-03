import { formulaError, isFormulaError, type FormulaValue, type ParsedFormula } from "./types.js";
import { evaluate } from "./evaluator.js";
export interface FormulaDefinition { readonly property: string; readonly formula: ParsedFormula }
export function findDependencyCycles(definitions: readonly FormulaDefinition[]): string[][] {
  const names=new Set(definitions.map(d=>d.property)); const edges=new Map(definitions.map(d=>[d.property,d.formula.dependencies.filter(x=>names.has(x))])); const visiting=new Set<string>(), done=new Set<string>(), path:string[]=[], cycles:string[][]=[];
  const visit=(name:string):void=>{ if(visiting.has(name)){const i=path.indexOf(name); cycles.push([...path.slice(i),name]); return;} if(done.has(name))return; visiting.add(name);path.push(name);for(const dep of edges.get(name)??[])visit(dep);path.pop();visiting.delete(name);done.add(name);};
  [...names].sort().forEach(visit); return cycles;
}
export function evaluateFormulaProperties(definitions: readonly FormulaDefinition[], base: Readonly<Record<string,FormulaValue>>): Record<string,FormulaValue> {
  const byName=new Map(definitions.map(d=>[d.property,d.formula])); const result:Record<string,FormulaValue>={...base}; const active=new Set<string>();
  const resolve=(name:string):FormulaValue=>{ if(Object.prototype.hasOwnProperty.call(result,name))return result[name]!; const formula=byName.get(name); if(!formula)return formulaError("NAME",`Unknown property '${name}'`); if(active.has(name))return formulaError("CYCLE",`Cyclic formula dependency at '${name}'`); active.add(name); const props:Record<string,FormulaValue>={...result}; for(const dep of formula.dependencies) props[dep]=resolve(dep); const depError=formula.dependencies.map(d=>props[d]!).find(isFormulaError); const value=depError??evaluate(formula,{properties:props}); active.delete(name); result[name]=value; return value;};
  [...byName.keys()].sort().forEach(resolve); return result;
}
