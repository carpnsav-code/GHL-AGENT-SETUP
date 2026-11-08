# Mint Concrete crew app
FROM node:22-alpine
WORKDIR /srv
COPY package.json ./
COPY app ./app
ENV NODE_ENV=production \
    PORT=3000 \
    MC_DB_FILE=/data/mint-concrete.sqlite
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "app/server.js"]
