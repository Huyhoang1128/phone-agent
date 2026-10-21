# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
ARG VITE_AGENT_TEAMS_URL
ENV VITE_AGENT_TEAMS_URL=${VITE_AGENT_TEAMS_URL}
ARG VITE_PEXELS_API_KEY
ENV VITE_PEXELS_API_KEY=${VITE_PEXELS_API_KEY}

RUN npm run build

# ── Stage 2: serve with nginx ────────────────────────────────────────────────
FROM nginx:stable-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
