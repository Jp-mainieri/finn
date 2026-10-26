// Entry point: see scripts/lib/admin-cli.mjs and the npm scripts in package.json.
import { run } from "./lib/admin-cli.mjs";

process.exitCode = await run(process.argv.slice(2));
