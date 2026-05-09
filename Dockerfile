FROM node:24-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY examples/basic-http-tool/package.json examples/basic-http-tool/package.json

RUN npm ci

COPY . .
RUN npm run build

CMD ["node", "packages/cli/dist/index.js", "--help"]
