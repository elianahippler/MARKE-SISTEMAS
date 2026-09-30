# syntax=docker/dockerfile:1
# Build context esperado: raiz do monorepo, com esta pasta em plugins/plugin-tomticket.
#
#   docker build -f plugins/plugin-tomticket/Dockerfile -t azx0025/marke-plugin-tomticket:latest .
#
# Base ALPINE (não há dependência nativa aqui) e `tsx` em `dependencies`, não em
# devDependencies: é ele que roda o TypeScript no runtime. Com `--omit=dev` e o
# tsx do lado de dev, o `npx tsx` do CMD tentaria BAIXAR o pacote no primeiro
# boot — falha em container sem rede para o registro.
#
# RUNTIME NODE (não Bun): padrão da casa desde que o http.request do Bun 1.2 se
# mostrou capaz de travar sem receber resposta do backend.

# ─────────────────────────────────────────────────────────────
# Stage 1: builder
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY packages/plugin-sdk ./packages/plugin-sdk
RUN cd packages/plugin-sdk \
 && npm install --no-save \
 && npm run build

COPY plugins/plugin-tomticket/package.json ./plugins/plugin-tomticket/
RUN cd plugins/plugin-tomticket \
 && npm install --omit=dev

COPY plugins/plugin-tomticket/src           ./plugins/plugin-tomticket/src
COPY plugins/plugin-tomticket/tsconfig.json ./plugins/plugin-tomticket/

# ─────────────────────────────────────────────────────────────
# Stage 2: runtime — só o que roda
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app/plugins/plugin-tomticket

# Do SDK, só o que o runtime precisa: o build, o package.json (que declara os
# `exports`) e as dependências DELE — é de lá que sai o `express` que o
# `dist/index.js` importa; cortá-lo derruba o container no boot com
# ERR_MODULE_NOT_FOUND.
COPY --from=builder /app/packages/plugin-sdk/dist          /app/packages/plugin-sdk/dist
COPY --from=builder /app/packages/plugin-sdk/node_modules  /app/packages/plugin-sdk/node_modules
COPY --from=builder /app/packages/plugin-sdk/package.json  /app/packages/plugin-sdk/package.json

COPY --from=builder /app/plugins/plugin-tomticket/node_modules  ./node_modules
COPY --from=builder /app/plugins/plugin-tomticket/package.json  ./package.json
COPY --from=builder /app/plugins/plugin-tomticket/tsconfig.json ./tsconfig.json
COPY --from=builder /app/plugins/plugin-tomticket/src           ./src

# Symlink /app/node_modules -> node_modules do plugin: o Node ESM resolve
# pacotes subindo a árvore a partir do ARQUIVO importador — o SDK
# (/app/packages/plugin-sdk/dist/index.js) importa express, e sem este symlink
# no caminho ancestral ele não encontra o pacote.
RUN ln -s /app/plugins/plugin-tomticket/node_modules /app/node_modules

ENV NODE_ENV=production
ENV PORT=3033
EXPOSE 3033

# Onde o provisionador monta o volume (`${STACK_NAME}-data:/app/data`).
ENV DATA_ROOT=/app/data

CMD ["npx", "tsx", "src/index.ts"]
