FROM node:20-slim AS base

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

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @xion-beginner/backgammon-server...

# Copy source code
COPY apps/backgammon-server/ apps/backgammon-server/
COPY packages/backgammon-core/ packages/backgammon-core/

# Build
WORKDIR /app/apps/backgammon-server
RUN pnpm run build

# Production stage
FROM node:20-slim AS production
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app
COPY --from=base /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=base /app/patches/ patches/
COPY --from=base /app/scripts/ scripts/
COPY --from=base /app/apps/backgammon-server/package.json apps/backgammon-server/
COPY --from=base /app/packages/backgammon-core/package.json packages/backgammon-core/
COPY --from=base /app/packages/tsconfig/ packages/tsconfig/

RUN pnpm install --frozen-lockfile --prod --filter @xion-beginner/backgammon-server...

COPY --from=base /app/apps/backgammon-server/dist/ apps/backgammon-server/dist/
COPY --from=base /app/packages/backgammon-core/ packages/backgammon-core/

WORKDIR /app/apps/backgammon-server
EXPOSE 3001

CMD ["node", "dist/index.js"]
