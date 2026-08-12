FROM node:26-alpine
WORKDIR /app

# Install prod deps only — Node runs the TS sources directly (native type-stripping),
# so there's no build/tsc step and dev dependencies aren't needed at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY tsconfig.json ./
COPY proto ./proto
COPY src ./src

# HTTP (client API) and gRPC (peer RPC) — actual ports come from env at runtime
EXPOSE 8080 9080

CMD ["npm", "start"]
