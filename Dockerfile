FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN rm -rf src/Breads-Shared && \
    git clone --depth 1 https://github.com/NguyenAnhDuc1711/Breads-Shared.git src/Breads-Shared

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npx", "tsx", "src/server.ts"]
