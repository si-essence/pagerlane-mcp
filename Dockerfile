FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.title="Pagerlane"
LABEL org.opencontainers.image.description="MCP server for a Keep API you already run. Tools use the keep_ prefix."
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
