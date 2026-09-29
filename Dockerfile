# syntax=docker/dockerfile:1

# Papergod in a container: Node server + TeX Live.
# Build and run with `docker compose up --build` (see docker-compose.yml).

ARG NODE_VERSION=20
# Debian trixie ships TeX Live 2024 (LaTeX 2024-11). Bookworm's TeX Live 2022
# is too old for current templates, e.g. it rejects a second
# \usepackage[table]{xcolor} that newer LaTeX/xcolor accept.
ARG DEBIAN_RELEASE=trixie

# --- Build: native modules (node-pty) and the React workbench bundle ---------
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web && npm prune --omit=dev

# --- Runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim

# A practical TeX Live selection for journal papers: pdfLaTeX, XeLaTeX,
# LuaLaTeX, BibTeX, Biber, latexmk, TikZ, and the common class/package
# collections. Set TEXLIVE_PACKAGES (e.g. texlive-full, ~5 GB) to replace it.
ARG TEXLIVE_DEFAULT="texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-pictures texlive-fonts-recommended texlive-bibtex-extra texlive-science texlive-publishers texlive-xetex texlive-luatex biber latexmk lmodern cm-super"
ARG TEXLIVE_PACKAGES=

RUN apt-get update \
 && apt-get install -y --no-install-recommends ${TEXLIVE_PACKAGES:-$TEXLIVE_DEFAULT} git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Papers are bind-mounted from the host and may be owned by another uid.
 && git config --system --add safe.directory '*'

WORKDIR /app
COPY --from=build /app /app

# /data is Papergod's home and holds the workspace registry (~/.papergod).
# /host is where docker-compose.yml mounts a host folder (HOST_DIR); paths
# typed in the app such as C:\Users\me\paper are translated to /host/paper.
# The built-in demo (opened on first start) must be writable for seeding.
# World-writable so the container also works when run with another --user.
RUN mkdir -p /data /host \
 && chown -R node:node /data /app/example \
 && chmod 0777 /data \
 && chmod -R a+rwX /app/example
ENV HOME=/data \
    NODE_ENV=production \
    SHELL=/bin/bash \
    PAPERGOD_HOST_MOUNT=/host

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/version').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Inside the container Papergod must listen on all interfaces so Docker can
# forward the port; docker-compose.yml publishes it on the host's 127.0.0.1
# only. Papergod has no login, so never publish it on a public interface.
# The entrypoint opens PAPERGOD_WORKSPACE if set, else the last-used paper.
ENTRYPOINT ["node", "/app/docker/entrypoint.mjs"]
