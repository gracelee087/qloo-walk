# TasteWalk — the whole app in one container (hackathon kit: Node >= 22.19,
# @qloo/qloo-harness, QLOO_API_KEY as a host secret — never baked into the image).
FROM node:22-slim
RUN npm install --global @qloo/qloo-harness@0.1.26
# hackathon keys only work on the hackathon base URL; the harness defaults to production
ENV QLOO_HOME=/app/.qloo
RUN mkdir -p /app/.qloo && qloo api config set base-url https://hackathon.api.qloo.com
WORKDIR /app
COPY index.html server.mjs package.json ./
COPY css ./css
COPY js ./js
COPY data ./data
COPY audio ./audio
COPY server ./server
COPY netlify/functions ./netlify/functions
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
