import { build } from "esbuild";
await build({ entryPoints: ["service-runner.mjs"], outfile: "dist/service-bundle.mjs", bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false });
