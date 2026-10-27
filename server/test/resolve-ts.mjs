import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source files import "./x.js" so wrangler can bundle the .ts. Node's test runner needs the .ts file.
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
    const tsUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsUrl.href, context);
  }
  return nextResolve(specifier, context);
}
