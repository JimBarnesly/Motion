import test from "node:test"; import assert from "node:assert/strict";
import { evaluate, evaluateFormulaProperties, findDependencyCycles, isFormulaError, parseFormula } from "../index.js";
const fixtures = [
  { source:"[Price] * [Quantity]", props:{Price:4.5,Quantity:2}, expected:9 },
  { source:'IF([Done], "yes", "no")', props:{Done:true}, expected:"yes" },
  { source:'UPPER([Name]) + "!"', props:{Name:"motion"}, expected:"MOTION!" },
  { source:'DAYS_BETWEEN(DATE("2026-08-04"), DATE("2026-08-01"))', props:{}, expected:3 },
  { source:'null = null and not EMPTY("x")', props:{}, expected:true }
] as const;
test("deterministic language fixtures",()=>{for(const fixture of fixtures){const parsed=parseFormula(fixture.source); assert.deepEqual(evaluate(parsed,{properties:fixture.props}),fixture.expected); assert.deepEqual(evaluate(parsed,{properties:fixture.props}),fixture.expected);}});
test("extracts sorted property dependencies",()=>assert.deepEqual(parseFormula("[Zulu] + [Alpha] + [Zulu]").dependencies,["Alpha","Zulu"]));
test("returns values for type and arithmetic errors",()=>{const value=evaluate(parseFormula("1 / 0"),{properties:{}}); assert.ok(isFormulaError(value)); if(isFormulaError(value))assert.equal(value.code,"DIV_ZERO");});
test("evaluates property formula graph",()=>{const defs=[{property:"Subtotal",formula:parseFormula("[Price] * [Count]")},{property:"Label",formula:parseFormula('CONCAT("NZ$", [Subtotal])')}]; assert.deepEqual(evaluateFormulaProperties(defs,{Price:3,Count:4}),{Price:3,Count:4,Subtotal:12,Label:"NZ$12"});});
test("detects and reports cycles",()=>{const defs=[{property:"A",formula:parseFormula("[B] + 1")},{property:"B",formula:parseFormula("[A] + 1")}]; assert.deepEqual(findDependencyCycles(defs),[["A","B","A"]]); const result=evaluateFormulaProperties(defs,{}); assert.ok(isFormulaError(result.A!)); assert.ok(isFormulaError(result.B!));});
test("rejects unsupported versions and syntax",()=>{assert.throws(()=>parseFormula("1",2));assert.throws(()=>parseFormula("1 +"));});
