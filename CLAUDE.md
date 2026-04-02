# XION Beginner Monorepo -- Project Rules

## Monorepo Structure

```
xion-beginner-monorepo/
├── apps/                  # All applications
├── packages/              # Shared internal packages
├── contracts/             # CosmWasm smart contracts (Rust)
├── patches/               # Node module patches (applied via postinstall)
└── scripts/               # Build/CI scripts
```

## Package Manager: pnpm

- **Always use pnpm** (v10+), never npm or yarn
- **Always run `pnpm install` from the monorepo root**, never from an app directory
- **Never create package-lock.json** -- pnpm uses `pnpm-lock.yaml`
- `.npmrc` is configured with `node-linker=hoisted` and public hoist patterns for Expo/React Native compatibility
- Run app commands from root: `pnpm --filter @xion-beginner/<app-name> <command>`
- Root convenience scripts exist for common apps (e.g. `pnpm dev:pyramid`, `pnpm dev:passport-web`)
- Node >= 18 required

## Naming Convention

- All app and package names use the `@xion-beginner/` scope in package.json
- Examples: `@xion-beginner/burnt-pyramid`, `@xion-beginner/xion-config`, `@xion-beginner/ui`

## App Inventory

### XION Blockchain Apps

| App | Directory | Stack | Description |
|-----|-----------|-------|-------------|
| burnt-pyramid | `apps/burnt-pyramid` | Next.js 16, Tailwind v4, React 18 | Pyramid payment splitter on XION blockchain. Uses Abstraxion SDK, Crossmint, Radix UI. |
| backgammon-web | `apps/backgammon-web` | Next.js 16, Tailwind v4, React 18 | Backgammon game frontend with SVG board, USDC wagers. Uses Abstraxion SDK, WebSocket game server. |
| backgammon-server | `apps/backgammon-server` | Express.js, ws | WebSocket game server for real-time backgammon. Server-authoritative moves, CSPRNG dice, matchmaking. |

### Passport / Verification Apps

| App | Directory | Stack | Description |
|-----|-----------|-------|-------------|
| passport-web | `apps/passport-web` | Next.js 14, React 18 | Passport verification frontend. Uses Reclaim Protocol JS SDK v4, ioredis, QR codes. |
| passport-backend | `apps/passport-backend` | Express.js | Backend API for passport verification. Uses Reclaim Protocol JS SDK v3. |
| passport-ios | `apps/passport-ios` | Expo 53, React Native 0.79, React 19 | Mobile app for passport. Uses Reclaim Protocol inapp RN SDK, Lottie animations, expo-camera. |

### Root Scripts

```
pnpm dev:pyramid              # burnt-pyramid
pnpm dev:passport-web         # passport-web
pnpm dev:passport-backend     # passport-backend
pnpm dev:backgammon-server    # backgammon game server (port 3001)
pnpm dev:backgammon-web       # backgammon web frontend (port 3000)
pnpm build                    # build all apps
pnpm test                 # run all tests
pnpm lint                 # lint all apps
pnpm typecheck            # typecheck all apps
pnpm clean                # remove node_modules, .next, dist, out, .expo from all apps
pnpm clean:install        # full clean + reinstall
```

## Shared Packages

### @xion-beginner/ui (`packages/ui`)

- Exports the `cn()` utility (clsx + tailwind-merge) for conditional Tailwind class merging
- **When to use:** Any app that needs Tailwind class merging
- **Usage:** `import { cn } from "@xion-beginner/ui"`
- Add as dependency: `"@xion-beginner/ui": "workspace:*"`
- In Next.js apps, add to `transpilePackages` in next.config

### @xion-beginner/xion-config (`packages/xion-config`)

- XION chain configuration constants (chain ID, RPC endpoints, etc.)
- Testnet: `xion-testnet-2`, RPC: `https://rpc.xion-testnet-2.burnt.com:443`
- `@cosmjs/cosmwasm-stargate` is an optional peer dependency
- **When to use:** Any app connecting to XION blockchain
- **Usage:** `import { CHAIN_CONFIG } from "@xion-beginner/xion-config"`
- Project-specific contract addresses and query functions stay in each app's own `lib/` files

### @xion-beginner/backgammon-core (`packages/backgammon-core`)

- Pure TypeScript backgammon rules engine, zero runtime dependencies
- Board state, move generation, move validation, game-over detection (normal/gammon/backgammon)
- Shared by `backgammon-web` (client) and `backgammon-server` (server-authoritative validation)
- **When to use:** Any app or server that needs backgammon game logic
- **Usage:** `import { createGameState, makeMove, getLegalFirstMoves } from "@xion-beginner/backgammon-core"`
- Key types: `GameState`, `BoardState`, `Move`, `Player` ("white" | "black")

### @xion-beginner/tsconfig (`packages/tsconfig`)

- Shared TypeScript config base files: `base.json` and `nextjs.json`
- **When to use:** Extend in any app's tsconfig.json
- **Usage:** `{ "extends": "@xion-beginner/tsconfig/nextjs.json" }`

### Shared Package Conventions

- Shared packages are **raw TypeScript** -- no build step needed
- Consumers transpile via `transpilePackages` in their next.config
- Use extensionless imports in shared package source files (no `.js` extensions)
- External dependencies that differ across apps should be `peerDependencies`
- Package.json pattern:
  ```json
  {
    "name": "@xion-beginner/<name>",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "exports": { ".": "./src/index.ts" }
  }
  ```

## Creating a New App

### Next.js Web App

1. Create directory `apps/<app-name>/`
2. Set `"name": "@xion-beginner/<app-name>"` in package.json
3. Add shared package deps as `"@xion-beginner/<pkg>": "workspace:*"`
4. Add `transpilePackages: ["@xion-beginner/xion-config", "@xion-beginner/ui"]` to next.config (if using those packages)
5. Delete any generated package-lock.json
6. Run `pnpm install` from monorepo root
7. Add convenience scripts to root package.json
8. For XION apps: add `@burnt-labs/abstraxion`, `@cosmjs/cosmwasm-stargate`, and `@xion-beginner/xion-config`
9. For non-blockchain apps: skip xion-config and Abstraxion deps

### Express.js Backend

1. Create directory `apps/<app-name>/`
2. Set `"name": "@xion-beginner/<app-name>"` in package.json with `"type": "module"`
3. Use `tsx watch src/index.ts` for dev, `tsc` for build
4. Add `dotenv`, `express`, `cors` as dependencies
5. Create `.env.example` with all required variables
6. Add convenience scripts to root package.json

### Expo/React Native Mobile App

1. Create directory `apps/<app-name>/`
2. Set `"name": "@xion-beginner/<app-name>"` and `"main": "expo-router/entry"` in package.json
3. Use Expo SDK ~53, React Native 0.79, React 19
4. The `.npmrc` already hoists react-native and expo packages for compatibility
5. Native build dirs (android/, ios/) are gitignored -- use `expo prebuild` to generate them
6. For XION integration: use `@burnt-labs/abstraxion-react-native`

### CosmWasm Smart Contract

1. Create a new standalone Cargo root under `contracts/<contract-name>/`
2. Always commit `Cargo.lock` files
3. Include a `deploy.sh` script and store compiled `.wasm` in `artifacts/`

## Creating a New Shared Package

1. Create directory under `packages/<name>/src/`
2. Follow the shared package conventions above
3. Do NOT extract project-specific UI components into shared packages (they use project-specific Tailwind tokens)
4. Only extract utilities that are genuinely reused across 2+ apps

## CosmWasm Contracts

| Contract | Directory | cosmwasm-std | Structure |
|----------|-----------|-------------|-----------|
| pyramid-splitter | `contracts/pyramid-splitter/` | =2.1.4 | Standalone crate |
| wager-escrow | `contracts/wager-escrow/` | =2.1.4 | USDC escrow for backgammon wagers. CreateEscrow, Deposit, Settle, Cancel, ClaimTimeout. |
| backgammon-game | `contracts/backgammon-game/` | =2.1.4 | Game registry with on-chain ratings. CreateGame, ReportResult, cross-contract escrow settlement. |

- Always commit `Cargo.lock` files

## Environment Variables

- Every app that needs env vars MUST have a `.env.example` file listing all required variables with placeholder values
- `.env` and `.env.*` files are gitignored (except `.env.example`)
- Common patterns:
  - XION apps: contract addresses, treasury addresses, chain config overrides
  - Backend apps: `PORT`, `DATABASE_URL`, API keys (Reclaim, Turnstile, etc.)
  - Mobile apps: backend API URLs
- Never share secrets across apps; each app has its own `.env`

## Deployment

- **Next.js web apps:** Deploy to Vercel. Each app has its own Vercel project. Root directory is set to `apps/<app-name>`.
- **Express.js backends:** Deploy to Vercel Serverless Functions. Use an `api/` output dir with esbuild bundling.
- **Expo mobile apps:** Use `expo build` / `eas build` for iOS and Android. No CI/CD for mobile yet.
- **CosmWasm contracts:** Compile with `cargo build --release --target wasm32-unknown-unknown`, optimize with `cosmwasm/optimizer`, deploy with the `deploy.sh` scripts in each contract dir.

## Patches

- Patches live in `patches/` at the monorepo root
- They are applied automatically via `postinstall` -> `scripts/apply-patches.sh`
- Patch filenames follow the pattern: `@scope+package+version.patch`
- When upgrading a patched package, regenerate the patch for the new version

## Dependency Management

- Add dependencies at the **app level** by default: `pnpm --filter @xion-beginner/<app> add <package>`
- Extract to a shared package ONLY when a dependency is used by 3+ apps with the same version and configuration
- Abstraxion SDK versions should stay aligned across all XION web apps
- Use `workspace:*` for internal package references
- Do NOT add root-level dependencies unless they are workspace tooling

## Testing

- Run all tests: `pnpm test` (runs `pnpm -r test`)
- Run tests for one app: `pnpm --filter @xion-beginner/<app-name> test`
- Mobile apps use Jest with ts-jest
- Web apps use ESLint for linting (`pnpm lint`), typecheck with `pnpm typecheck`
- No shared test utilities package exists yet; tests are self-contained per app

## XION / Blockchain

- Chain config constants live in `packages/xion-config/src/constants.ts`
- Testnet: `xion-testnet-2`, RPC: `https://rpc.xion-testnet-2.burnt.com:443`
- `@cosmjs/cosmwasm-stargate` is an optional peer dep of `@xion-beginner/xion-config`
- Abstraxion SDK versions should stay aligned across all web apps
- Project-specific contract addresses and query functions stay in each app's own `lib/` files

## What NOT To Do

- Do NOT run `npm install` or `yarn install` inside any app directory
- Do NOT create package-lock.json or yarn.lock files
- Do NOT add `.js` extensions to imports in shared packages
- Do NOT extract project-specific UI components into shared packages (they use project-specific Tailwind tokens)
- Do NOT commit `.env` files, node_modules, target/, or .next/ directories
- Do NOT add root-level app dependencies (all deps belong in their respective app's package.json)
- Do NOT use `npx` for monorepo scripts; use `pnpm` filter commands instead

## Abstraxion SDK Known Bugs

### Treasury Grant Comparison Bug (v1.0.0-alpha.65+)

`fetchChainGrantsABCI` in `@burnt-labs/abstraxion-core` decodes chain grants to REST format (`@type` key), but `compareGrantsToTreasuryWithConfigs` accesses `.typeUrl` (protobuf format) which is always `undefined`. This causes all grants to be decoded as "Unsupported" and treasury comparison always fails.

**Symptom**: "Poll for grants was unsuccessful" error after redirect.

**Fix**: Run `~/.claude/scripts/patch-abstraxion.sh <app-dir>` to find and patch ALL copies of `abstraxion-core` dist files automatically. This must be re-run after every `pnpm install`.

### Callback URL Accumulation

Without explicit `callbackUrl`, the SDK uses `window.location.href` (including stale query params) as redirect URI, causing loops. Always set in AbstraxionProvider config:
```tsx
authentication: {
  type: 'redirect' as const,
  callbackUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
}
```

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
