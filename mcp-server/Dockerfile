FROM node:20-slim

# Add labels for container identification
LABEL org.opencontainers.image.source="https://github.com/worldbop/serendiggity-mcp"
LABEL org.opencontainers.image.description="Serendiggity MCP Server"

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh mcp

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy source code
COPY . .

# Create persistent data directory for SQLite
RUN mkdir -p /data/db && chown -R mcp:nodejs /data

# Change ownership of app directory
RUN chown -R mcp:nodejs /app

# Switch to non-root user
USER mcp

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/db/mcp-server.db

EXPOSE 3001

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

CMD ["node", "index.js"]
