FROM node:22-bookworm AS frontend-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM golang:1.25.9-bookworm AS backend-build

WORKDIR /src/backend

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/backend ./cmd/server


FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx gettext-base ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=frontend-build /app/.next/standalone ./frontend
COPY --from=frontend-build /app/.next/static ./frontend/.next/static
COPY --from=frontend-build /app/public ./frontend/public
COPY --from=backend-build /out/backend ./bin/backend
COPY deploy/start.sh ./deploy/start.sh
COPY deploy/nginx.conf.template ./deploy/nginx.conf.template

RUN chmod +x /app/deploy/start.sh

ENV FRONTEND_PORT=3000
ENV BACKEND_PORT=8080
ENV HOSTNAME=0.0.0.0
ENV NEXT_PUBLIC_AI_CHAT_ENABLED=false
ENV NGINX_CLIENT_MAX_BODY_SIZE=20m

EXPOSE 10000

CMD ["/app/deploy/start.sh"]
