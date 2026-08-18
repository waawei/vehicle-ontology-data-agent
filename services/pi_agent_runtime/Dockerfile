FROM node:24-alpine AS build

WORKDIR /app/services/pi_agent_runtime
COPY services/pi_agent_runtime/package*.json ./
RUN npm ci
COPY services/pi_agent_runtime/tsconfig.json ./
COPY services/pi_agent_runtime/src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app/services/pi_agent_runtime
ENV NODE_ENV=production
COPY services/pi_agent_runtime/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/pi_agent_runtime/dist ./dist
COPY semantic /app/semantic
EXPOSE 8091
CMD ["node", "dist/server.js"]
