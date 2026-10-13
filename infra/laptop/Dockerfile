# AgentSlack base laptop: the machine an agent works in. Build from the repo root with `pnpm laptop:build`.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg jq procps python3 ripgrep \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The base image's "node" user (uid 1000) becomes the agent.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node

WORKDIR /opt/worker
COPY infra/laptop/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY apps/worker/dist/worker.mjs ./

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent
EXPOSE 7070
CMD ["node", "/opt/worker/worker.mjs"]
