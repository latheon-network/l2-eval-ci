# Caddy with the rate_limit handler (github.com/mholt/caddy-ratelimit, pinned to a commit: the module has no tags).
# Built once on the server by "docker compose build caddy" (setup-server.sh and deploy-chain.sh do it).
ARG CADDY_TAG=2.11.7
FROM caddy:${CADDY_TAG}-builder AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db
FROM caddy:${CADDY_TAG}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
