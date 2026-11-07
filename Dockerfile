FROM oven/bun:1.4.4-alpine AS builder
WORKDIR /app

# Instala TODAS as dependências (incluindo dev para o build)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copia o código-fonte e compila
COPY . .
RUN ./node_modules/.bin/nest build

# ── Runtime ──────────────────────────────────────────────
FROM oven/bun:1.4.4-alpine AS runner
WORKDIR /app

# Apenas dependências de produção
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copia o build gerado
COPY --from=builder /app/dist ./dist

# A imagem só tem o build JS: a CLI do MikroORM deve usar dist/, não src/
ENV MIKRO_ORM_CLI_USE_TS_NODE=false

EXPOSE 3000

CMD ["node", "dist/main"]
