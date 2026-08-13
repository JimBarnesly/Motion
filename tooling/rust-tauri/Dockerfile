FROM rust@sha256:1e1a513eb893a8638b62724043a1903475ae09fd92b67eb2dfe31996c5ae120d AS rust-toolchain

FROM node@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential=12.9 \
      libayatana-appindicator3-dev=0.5.92-1 \
      libglib2.0-0=2.74.6-2+deb12u9 \
      libgtk-3-dev=3.24.38-2~deb12u3 \
      librsvg2-dev=2.54.7+dfsg-1~deb12u1 \
      libssl-dev=3.0.20-1~deb12u2 \
      libwebkit2gtk-4.1-dev=2.50.6-1~deb12u2 \
      libxdo-dev=1:3.20160805.1-5 \
      pkg-config=1.8.1-1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

# Prime both locked dependency stores at image-build time. Runtime validation is
# network-disabled and cannot fall back to the host's Rust, Cargo, GLib or npm cache.
COPY . /opt/motion-seed
RUN cd /opt/motion-seed \
 && npm ci --ignore-scripts \
 && chmod -R a+rX /opt/motion-seed/node_modules \
 && cargo fetch --locked --manifest-path apps/desktop/src-tauri/Cargo.toml \
 && chmod -R a+rX /usr/local/cargo/registry \
 && rustc --version | grep -Fx 'rustc 1.97.1 (8bab26f4f 2026-07-14)'

WORKDIR /workspace
USER 1000:1000
