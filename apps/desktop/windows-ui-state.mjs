import { invokeWindowsNativeHelper } from "@motion/storage";
import { inspectWindowsPrivateFile, writeWindowsPrivateFile } from "./windows-backup-file.mjs";

// Windows must create the temporary with an explicit current-user owner and
// private DACL. Node's default file owner can instead be Administrators under an
// elevated token, even inside an owner-private directory.
export function createWindowsUiStateStore(path, invoke = invokeWindowsNativeHelper) {
  return {
    read() {
      const existing = inspectWindowsPrivateFile(path, invoke);
      return existing.exists ? JSON.parse(existing.contents) : {};
    },
    write(state) {
      const contents = JSON.stringify(state);
      const existing = inspectWindowsPrivateFile(path, invoke);
      return writeWindowsPrivateFile(path, contents, existing.exists ? existing.identity : undefined, invoke);
    }
  };
}
