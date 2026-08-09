const mode = process.argv[2];
const canary = process.argv[3] ?? "PRIVATE_CANARY_SHOULD_NOT_ESCAPE";
if (mode === "leak") { process.stdout.write(`${canary}\n`); process.stderr.write(`private/${canary}/operator\n`); process.exit(1); }
if (mode !== "pass") process.exit(1);
