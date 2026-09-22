# Only needed for hosts that want a container (Cloud Run, Fly, a VPS...).
# Render uses render.yaml and does not need this file.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 7788
# Nothing here needs root.
RUN mkdir -p /app/cache && chown -R node:node /app
USER node
CMD ["node", "src/boot.js"]
