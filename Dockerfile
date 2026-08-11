FROM node:26-alpine
WORKDIR /app

# Install dependencies first (better layer caching). We run via tsx, so dev deps are needed.
COPY package.json package-lock.json ./
RUN npm ci

# App source
COPY tsconfig.json ./
COPY proto ./proto
COPY src ./src

# HTTP (client API) and gRPC (peer RPC) — actual ports come from env at runtime
EXPOSE 8080 9080

CMD ["npm", "start"]
