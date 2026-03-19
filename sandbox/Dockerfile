FROM alpine:3.23

# System packages (matches previous rootfsPackages minus linux-virt and rng-tools which are boot-only)
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    nodejs \
    npm \
    uv \
    python3 \
    openssh \
    libgcc \
    libstdc++ \
    ripgrep \
    git \
    github-cli \
    go \
    jq \
    file

# Upgrade npm (Alpine's bundled version is too old)
RUN rm -rf /usr/lib/node_modules/npm \
    && mkdir -p /usr/lib/node_modules/npm \
    && curl -fsSL https://registry.npmjs.org/npm/-/npm-11.2.0.tgz \
       | tar -xz -C /usr/lib/node_modules/npm --strip-components=1

# Git config
RUN printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig \
    && printf '.venv-sandbox/\n' > /etc/gitignore_global \
    && git config --file /etc/gitconfig core.excludesFile /etc/gitignore_global \
    && git config --file /etc/gitconfig user.name "Eli Dickinson" \
    && git config --file /etc/gitconfig user.email "eli@elidickinson.com"

# curl-impersonate
RUN curl -fsSL https://github.com/lexiforest/curl-impersonate/releases/download/v1.5.1/curl-impersonate-v1.5.1.aarch64-linux-musl.tar.gz \
    | tar -xz -C /usr/local/bin

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# browser-cli
RUN npm install -g https://github.com/elidickinson/browser-cli/archive/refs/heads/dev.tar.gz

# acpx
RUN npm install -g acpx@latest

# Guest tools from sandbox/guest-tools/
COPY guest-tools/ /usr/local/lib/guest-tools/
RUN chmod +x /usr/local/lib/guest-tools/* \
    && ln -sf /usr/local/lib/guest-tools/* /usr/local/bin/

# Build info (changes every build, so keep last to maximize cache hits)
ARG BUILD_INFO="unknown"
RUN echo "$BUILD_INFO" > /etc/build-info
