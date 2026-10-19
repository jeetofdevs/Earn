# Builds and serves the EARN website (web/). The contract in contract/ is
# deployed to NEAR separately, not to Railway.

FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Set these as Railway service variables; Railway passes them in at build time.
ARG VITE_NETWORK=testnet
ARG VITE_CONTRACT_ID=earn-gacha.testnet
ENV VITE_NETWORK=$VITE_NETWORK VITE_CONTRACT_ID=$VITE_CONTRACT_ID
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
