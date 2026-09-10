# ElasticVue Pro — hosted core. Two stages: build the Rust bridge, then ship only the
# binary and the static UI on a minimal image.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml
# The Tauri shell is a workspace member but not built here; a stub keeps the workspace valid.
RUN mkdir -p src-tauri/src && echo 'fn main(){}' > src-tauri/src/main.rs && echo '' > src-tauri/build.rs
RUN cargo build --release -p espro-core --features bridge --bin espro-bridge

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --home /app --shell /usr/sbin/nologin espro
WORKDIR /app
COPY --from=build /src/target/release/espro-bridge /usr/local/bin/espro-bridge
COPY ui ./ui
RUN mkdir -p /app/data && chown -R espro:espro /app
USER espro
# Hosted mode: bind the compose network, not loopback. nginx is the only way in.
ENV ESPRO_BIND=0.0.0.0 ESPRO_DATA_DIR=/app/data RUST_LOG=info
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf -X POST http://127.0.0.1:8765/bridge \
  -H 'content-type: application/json' -H 'x-auth-user: healthcheck' -d '{"type":"PING"}' >/dev/null || exit 1
ENTRYPOINT ["espro-bridge", "/app/ui", "8765"]
