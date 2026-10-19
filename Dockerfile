# Builds the EARN website and runs its server (web/): serves the site, takes
# wallet submissions per 30-minute batch, and can auto-draw. The contract in
# contract/ is deployed to NEAR separately.

FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Set these as Railway service variables; Railway passes them in at build time.
ARG VITE_NETWORK=mainnet
ARG VITE_CONTRACT_ID
ENV VITE_NETWORK=$VITE_NETWORK VITE_CONTRACT_ID=$VITE_CONTRACT_ID
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev
COPY web/server ./server
COPY --from=build /app/dist ./dist
# Batch entries are saved here. On Railway, attach a volume at /data.
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["npm", "start"]
