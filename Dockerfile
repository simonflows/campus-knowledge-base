# Production image for the Next.js app.

FROM node:24-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_DEMO_MODE=false

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN mkdir -p public

RUN npm run build && mkdir -p .next/cache

# Production stage
FROM node:24-alpine AS runner

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
LABEL org.opencontainers.image.version=0.9.7

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_DEMO_MODE=false
ENV NPM_CONFIG_CACHE=/tmp/npm
ENV CAMPUS_SOURCE_REVISION=$VCS_REF

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
# The runtime uses tsx for deployment checks and database migration.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts /app/tsconfig.json ./
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/app ./app
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/deploy/preflight.ts ./deploy/

USER 1001:1001

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r => { process.exitCode = r.ok ? 0 : 1 }).catch(() => { process.exitCode = 1 })"]

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "8080"]
