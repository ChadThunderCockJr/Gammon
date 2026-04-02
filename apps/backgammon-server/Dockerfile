FROM node:20-slim

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace root files needed for install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches/ patches/
COPY scripts/ scripts/

# Copy the server app and its workspace dependencies
COPY apps/backgammon-server/package.json apps/backgammon-server/
COPY packages/backgammon-core/package.json packages/backgammon-core/
COPY packages/tsconfig/ packages/tsconfig/

# Install all dependencies (including tsx for running TypeScript)
RUN pnpm install --frozen-lockfile --filter @xion-beginner/backgammon-server...

# Copy source code
COPY apps/backgammon-server/ apps/backgammon-server/
COPY packages/backgammon-core/ packages/backgammon-core/

WORKDIR /app/apps/backgammon-server
EXPOSE 3001

# Use tsx to run TypeScript directly (handles raw TS workspace packages)
CMD ["npx", "tsx", "src/index.ts"]
