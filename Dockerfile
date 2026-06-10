# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-client jq ripgrep fd-find less unzip zip tree procps lsof \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && mkdir -p /paperclip \
  && chown node:node /paperclip
RUN curl https://cursor.com/install -fsS | bash \
  && chmod a+rx /root /root/.local /root/.local/bin /root/.local/share \
  && chmod -R a+rX /root/.local/share/cursor-agent \
  && ln -sf /root/.local/bin/agent /usr/local/bin/agent \
  && ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent

RUN npm install --global bun@latest

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Install chromium runtime libs explicitly with Debian trixie names; Playwright's
# own --with-deps falls back to Ubuntu 20.04 package names on arm64 and breaks on
# ttf-unifont / ttf-ubuntu-font-family which don't exist in Debian.
# Playwright documents --only-shell for headless-only CI/container use:
# https://playwright.dev/docs/browsers#chromium-headless-shell
RUN <<'EOF'
set -eux

apt-get update
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libdbus-1-3 \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
  libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libxcb1 libpango-1.0-0 libcairo2 libasound2t64 \
  fonts-liberation fonts-unifont
rm -rf /var/lib/apt/lists/*
mkdir -p /opt/ms-playwright

echo "Playwright version:"
pnpm exec playwright --version

echo "Playwright chromium-headless-shell install dry run:"
pnpm exec playwright install --dry-run --only-shell chromium

echo "Installing Chromium headless shell into ${PLAYWRIGHT_BROWSERS_PATH}"
PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 DEBUG=pw:api,pw:browser \
  timeout --foreground 20m pnpm exec playwright install --only-shell chromium

echo "Installed Playwright browsers:"
pnpm exec playwright install --list
find /opt/ms-playwright -maxdepth 2 -mindepth 1 -type d -print
chmod -R a+rX /opt/ms-playwright
EOF

RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${arch}.tgz" \
    | tar -xz -C /usr/local/bin ngrok \
  && chmod 0755 /usr/local/bin/ngrok

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
