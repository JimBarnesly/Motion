import type { AppCommand } from "../../../packages/app-service/src/index.js";
import type { NativeCommandPayloads } from "../app-adapter.js";

type NativeServiceCommand = Exclude<AppCommand, { type: "workspace.import-web-v1" }>;
type NativeServiceOperation = NativeServiceCommand["type"];
type NativeServicePayloads = {
  [Operation in NativeServiceOperation]: Omit<
    Extract<NativeServiceCommand, { type: Operation }>,
    "type" | "workspaceId" | "expectedRevision"
  >;
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type MutuallyAssignable<Left, Right> = Left extends Right ? Right extends Left ? true : false : false;
type AssertTrue<Value extends true> = Value;

export type NativeCommandKeysAreExhaustive = AssertTrue<
  Equal<keyof NativeCommandPayloads, NativeServiceOperation>
>;
type MismatchedNativeCommandPayloads = {
  [Operation in NativeServiceOperation]: MutuallyAssignable<NativeCommandPayloads[Operation], NativeServicePayloads[Operation]> extends true ? never : Operation
}[NativeServiceOperation];
const noMismatchedNativeCommandPayloads: never = null as unknown as MismatchedNativeCommandPayloads;
export type NativeCommandPayloadsMatchService = typeof noMismatchedNativeCommandPayloads;
