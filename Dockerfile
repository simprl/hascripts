# syntax=docker/dockerfile:1

FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json

RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/web/dist /app/packages/web/dist
COPY --from=build /app/packages/scripts /app/packages/scripts

EXPOSE 8080

CMD ["node", "packages/server/dist/index.js"]
