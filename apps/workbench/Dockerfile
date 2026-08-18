FROM node:24-alpine AS build

WORKDIR /app
COPY apps/workbench/package*.json ./
RUN npm ci
COPY apps/workbench ./
RUN npm run build

FROM nginx:1.27-alpine
COPY apps/workbench/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
