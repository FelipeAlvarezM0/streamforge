# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json ./
COPY .eslintrc.json ./
COPY .prettierrc.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY migrations ./migrations

RUN npm install
RUN npm run build

ARG APP_NAME
ENV APP_NAME=${APP_NAME}

CMD ["sh", "-c", "node apps/${APP_NAME}/dist/main.js"]
