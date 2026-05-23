FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ccache \
    git \
    python3 \
    ca-certificates \
    curl \
    wget \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install js-beautify globally (needed by wasm_build_lib.sh)
RUN npm install -g js-beautify

# Install Emscripten SDK (matching upstream CI at v1.5.2)
#   3.1.71 for MVP/EH builds
#   3.1.57 for COI builds (newer versions break pthread worker spawning)
ENV EMSDK=/opt/emsdk
RUN git clone https://github.com/emscripten-core/emsdk.git $EMSDK \
    && cd $EMSDK \
    && ./emsdk install 3.1.71 \
    && ./emsdk activate 3.1.71
RUN cd $EMSDK && ./emsdk install 3.1.57

# Upgrade binaryen: LLVM in emsdk 3.1.71 produces wasm with bulk-memory-opt
# feature flag, which the bundled binaryen v117 doesn't support.
RUN curl -sL https://github.com/WebAssembly/binaryen/releases/download/version_126/binaryen-version_126-x86_64-linux.tar.gz \
    | tar -xz -C /tmp \
    && cp /tmp/binaryen-version_126/bin/* $EMSDK/upstream/bin/ \
    && rm -rf /tmp/binaryen-version_126

ENV PATH="$EMSDK:$EMSDK/upstream/emscripten:$PATH"
ENV EM_CONFIG="$EMSDK/.emscripten"

# Install Rust nightly (wasm32-unknown-emscripten is tier 3)
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ENV PATH="$CARGO_HOME/bin:$PATH"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y --default-toolchain nightly --profile minimal \
    && rustup target add wasm32-unknown-emscripten --toolchain nightly \
    && rustup component add rust-src --toolchain nightly

# Configure ccache and cargo cache
ENV CCACHE_DIR=/cache/ccache
ENV CCACHE_MAXSIZE=5G
ENV CARGO_TARGET_DIR=/cache/cargo-target

WORKDIR /src

COPY scripts/docker-build.sh /usr/local/bin/docker-build.sh
RUN chmod +x /usr/local/bin/docker-build.sh

ENTRYPOINT ["/usr/local/bin/docker-build.sh"]
