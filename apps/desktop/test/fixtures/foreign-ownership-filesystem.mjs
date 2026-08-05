import * as filesystem from "node:fs/promises";

let target = null;
export const setForeignOwnershipTarget = value => { target = value; };
const isForeign = path => target === "both" || target === "lock" && String(path).endsWith(".motion-backup.lock")
  || target === "temporary" && String(path).endsWith(".tmp");
const foreign = (metadata, path) => {
  if (!isForeign(path)) return metadata;
  const clone = Object.create(Object.getPrototypeOf(metadata), Object.getOwnPropertyDescriptors(metadata));
  Object.defineProperty(clone, "uid", { ...Object.getOwnPropertyDescriptor(clone, "uid"), value: -1 });
  return clone;
};

export const lstat = async path => foreign(await filesystem.lstat(path), path);
export const open = async (path, ...args) => {
  const handle = await filesystem.open(path, ...args);
  if (!isForeign(path)) return handle;
  return new Proxy(handle, { get(object, property) {
    if (property === "stat") return async (...statArgs) => foreign(await object.stat(...statArgs), path);
    const value = Reflect.get(object, property, object); return typeof value === "function" ? value.bind(object) : value;
  } });
};
export const { link, readFile, readdir, rm, stat } = filesystem;
