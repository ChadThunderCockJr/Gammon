FROM node:20.19.5-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY scripts/ ./scripts/
COPY apps/backgammon-server/package.json ./apps/backgammon-server/
COPY packages/backgammon-core/package.json ./packages/backgammon-core/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/backgammon-server/ ./apps/backgammon-server/
COPY packages/backgammon-core/ ./packages/backgammon-core/
WORKDIR /app/apps/backgammon-server
RUN pnpm build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/patches/ ./patches/
COPY --from=build /app/scripts/ ./scripts/
COPY --from=build /app/apps/backgammon-server/package.json ./apps/backgammon-server/
COPY --from=build /app/packages/backgammon-core/package.json ./packages/backgammon-core/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
COPY --chown=node:node --from=build /app/apps/backgammon-server/dist/ ./apps/backgammon-server/dist/
COPY --chown=node:node --from=build /app/packages/backgammon-core/ ./packages/backgammon-core/
WORKDIR /app/apps/backgammon-server
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/index.js"]
