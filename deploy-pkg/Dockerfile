FROM node:20-slim
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY server.js ./
COPY dist/server/ dist/server/
COPY dist/static/ dist/static/

EXPOSE 5000

ENV USE_MEMORY_DB=true
ENV PORT=5000
ENV NODE_ENV=production

CMD ["node", "server.js"]
