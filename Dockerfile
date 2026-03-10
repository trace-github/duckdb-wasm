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

# Install Emscripten SDK 4.0.3
# This version natively bundles binaryen v126, which supports
# --enable-bulk-memory-opt. No separate binaryen install needed.
ENV EMSDK=/opt/emsdk
RUN git clone https://github.com/emscripten-core/emsdk.git $EMSDK \
    && cd $EMSDK \
    && ./emsdk install 4.0.3 \
    && ./emsdk activate 4.0.3

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