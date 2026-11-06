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

EXPOSE 3000

CMD ["node", "dist/main"]
