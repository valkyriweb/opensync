# syntax=docker/dockerfile:1
# OpenSync dashboard frontend — static Vite SPA served by unprivileged nginx.
# Build for the cluster with: docker buildx build --platform linux/amd64
# VITE_* are baked at build time (Vite inlines them); none are secret.

# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_CONVEX_URL
ARG VITE_WORKOS_CLIENT_ID
ARG VITE_REDIRECT_URI
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL \
    VITE_WORKOS_CLIENT_ID=$VITE_WORKOS_CLIENT_ID \
    VITE_REDIRECT_URI=$VITE_REDIRECT_URI
RUN npm run build

# --- serve stage ---
FROM nginxinc/nginx-unprivileged:1.27-alpine AS serve
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
