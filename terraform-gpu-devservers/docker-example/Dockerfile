# Test Dockerfile for GPU Dev Server
# Extends the default PyTorch GPU dev image with enhanced terminal tools
FROM 308535385114.dkr.ecr.us-east-2.amazonaws.com/pytorch-gpu-dev-gpu-dev-image:latest-60842eac

# Switch to root for package installation
USER root

# Update package list and install enhanced terminal tools
RUN apt-get update && apt-get install -y \
    # Development dependencies for building from source
    build-essential \
    pkg-config \
    libevent-dev \
    libncurses-dev \
    bison \
    autotools-dev \
    automake \
    # Network and locale tools
    locales \
    # Additional shell options
    fish \
    # Cleanup
    && rm -rf /var/lib/apt/lists/*

# Install Neovim (latest stable version)
RUN curl -fsSL https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.tar.gz | \
    tar -xzC /opt && \
    ln -sf /opt/nvim-linux-x86_64/bin/nvim /usr/local/bin/nvim && \
    # Create vim alias pointing to neovim
    ln -sf /opt/nvim-linux-x86_64/bin/nvim /usr/local/bin/vim

# Install Eternal Terminal (et)
RUN wget -qO - https://github.com/MisterTea/EternalTerminal/releases/download/et-v6.2.4/et_6.2.4_amd64.deb \
    -O /tmp/et.deb && \
    dpkg -i /tmp/et.deb || apt-get install -f -y && \
    rm /tmp/et.deb

# Install Mosh (mobile shell)
RUN apt-get update && apt-get install -y \
    mosh \
    && rm -rf /var/lib/apt/lists/*

# Install newer tmux from source (latest stable)
RUN cd /tmp && \
    wget https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz && \
    tar -xzf tmux-3.4.tar.gz && \
    cd tmux-3.4 && \
    ./configure --prefix=/usr/local && \
    make && make install && \
    cd / && rm -rf /tmp/tmux-* && \
    # Create symlink to override system tmux
    ln -sf /usr/local/bin/tmux /usr/bin/tmux

# Configure locale (required for mosh)
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8


# Add useful aliases and environment configurations
RUN echo '# Enhanced terminal aliases' >> /etc/zsh/zshrc && \
    echo 'alias ll="ls -la"' >> /etc/zsh/zshrc && \
    echo 'alias la="ls -la"' >> /etc/zsh/zshrc && \
    echo 'alias ..="cd .."' >> /etc/zsh/zshrc && \
    echo 'alias ...="cd ../.."' >> /etc/zsh/zshrc && \
    echo 'alias grep="grep --color=auto"' >> /etc/zsh/zshrc && \
    echo 'alias tmux="tmux -2"' >> /etc/zsh/zshrc && \
    echo 'export EDITOR=nvim' >> /etc/zsh/zshrc && \
    echo 'export VISUAL=nvim' >> /etc/zsh/zshrc

# Create a basic tmux configuration
RUN echo '# Enhanced tmux configuration' > /etc/tmux.conf && \
    echo 'set -g default-terminal "screen-256color"' >> /etc/tmux.conf && \
    echo 'set -g mouse on' >> /etc/tmux.conf && \
    echo 'set -g history-limit 10000' >> /etc/tmux.conf && \
    echo 'bind r source-file ~/.tmux.conf \\; display-message "Config reloaded"' >> /etc/tmux.conf

# Add version info for verification
RUN echo "=== Tool Versions ===" && \
    /usr/local/bin/tmux -V && \
    /usr/local/bin/nvim --version | head -1 && \
    et --version 2>/dev/null || echo "Eternal Terminal installed" && \
    mosh --version | head -1 && \
    echo "===================="

# Switch back to the original user (if any)
# The gpu-dev system will handle user creation and permissions
USER root

# Copy hello.txt from build context to /var
COPY hello.txt /var/hello.txt

# The gpu-dev startup script will handle SSH daemon, user setup, etc.
# This Dockerfile just adds the enhanced tools to the base PyTorch image