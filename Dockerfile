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

# Install Emscripten SDK 3.1.57
ENV EMSDK=/opt/emsdk
RUN git clone https://github.com/emscripten-core/emsdk.git $EMSDK \
    && cd $EMSDK \
    && ./emsdk install 3.1.57 \
    && ./emsdk activate 3.1.57

# Upgrade binaryen to v126.
# The binaryen bundled with emsdk 3.1.57 (wasm-opt v117) doesn't support
# --enable-bulk-memory-opt which clang now emits in wasm target features.
RUN BINARYEN_VERSION=126 && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        BINARYEN_ARCH="aarch64"; \
    else \
        BINARYEN_ARCH="x86_64"; \
    fi && \
    wget -q "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${BINARYEN_ARCH}-linux.tar.gz" -O /tmp/binaryen.tar.gz && \
    tar xzf /tmp/binaryen.tar.gz -C /tmp && \
    cp /tmp/binaryen-version_${BINARYEN_VERSION}/bin/* $EMSDK/upstream/bin/ && \
    cp /tmp/binaryen-version_${BINARYEN_VERSION}/lib/* $EMSDK/upstream/lib/ 2>/dev/null || true && \
    rm -rf /tmp/binaryen*

# Set up emscripten in PATH. emsdk activate already wrote .emscripten config.
ENV PATH="$EMSDK:$EMSDK/upstream/emscripten:$PATH"
ENV EM_CONFIG="$EMSDK/.emscripten"

# Configure ccache to use the mounted cache volume
ENV CCACHE_DIR=/cache/ccache
ENV CCACHE_MAXSIZE=5G

WORKDIR /src

COPY docker-build.sh /usr/local/bin/docker-build.sh
RUN chmod +x /usr/local/bin/docker-build.sh

ENTRYPOINT ["/usr/local/bin/docker-build.sh"]