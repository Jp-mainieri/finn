// Lets plain Node run the repo's TypeScript with its extensionless relative imports
// ("./store" -> "./store.ts"). Used with --experimental-transform-types (parameter properties).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".") || err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          /* try next */
        }
      }
      throw err;
    }
  },
});
