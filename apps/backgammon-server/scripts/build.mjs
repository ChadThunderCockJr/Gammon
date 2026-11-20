import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = resolve(packageRoot, "../../packages/backgammon-core/src/index.ts");

await build({
  absWorkingDir: packageRoot,
  alias: {
    "@xion-beginner/backgammon-core": coreEntry,
  },
  bundle: true,
  entryPoints: {
    index: "src/index.ts",
    migrate: "src/migrate.ts",
    "funds-preflight": "src/funds-preflight.ts",
  },
  entryNames: "[name]",
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  outdir: "dist",
  packages: "external",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
