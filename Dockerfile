# Builds the EARN website (web/) and serves it.

FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev
COPY web/server ./server
COPY --from=build /app/dist ./dist
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
