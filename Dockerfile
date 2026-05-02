FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PORT=8080
EXPOSE 8080

# Raise file descriptor limit for high WS concurrency (Alpine)
RUN echo -e '\nnofile 65535 65535' >> /etc/security/limits.conf 2>/dev/null || true

CMD ["sh", "-c", "ulimit -n 65535 2>/dev/null; node --max-old-space-size=768 server.js"]
