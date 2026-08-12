const [bundlePath, root, mask] = process.argv.slice(2);
process.umask(Number.parseInt(mask, 8));
process.argv = [process.execPath, bundlePath, root];
await import(bundlePath);