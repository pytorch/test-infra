# Custom PyTorch GPU Development Server Image
# Based on pytorch/pytorch:2.8.0-cuda12.9-cudnn9-devel
FROM pytorch/pytorch:2.8.0-cuda12.9-cudnn9-devel

# Set environment variables for non-interactive installation
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Update package lists with retries and install essential packages
RUN for attempt in 1 2 3; do \
        echo "Package update attempt $attempt..." && \
        apt-get update -qq && break || \
        ([ $attempt -lt 3 ] && echo "Update failed, waiting 30s..." && sleep 30) \
    done

# Install system packages in layers for better caching
RUN apt-get install -y --no-install-recommends \
        openssh-server \
        sudo \
        curl \
        wget \
        vim \
        nano \
        git \
        coreutils \
        util-linux \
        procps \
        zsh \
        bash-completion \
        ca-certificates \
        gnupg \
        lsb-release

# Install Node.js 20 from NodeSource (required for Claude CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Install Python packages (Jupyter and common ML packages)
RUN pip install --no-cache-dir \
        jupyterlab \
        ipywidgets \
        matplotlib \
        seaborn \
        pandas \
        numpy \
        scikit-learn \
        plotly \
        tensorboard

# Create dev user with consistent UID (1000)
RUN useradd -u 1000 -m -s /usr/bin/zsh dev && \
    usermod -aG sudo dev && \
    echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && \
    echo 'Defaults lecture=never' >> /etc/sudoers.d/dev && \
    echo 'Defaults !lecture' >> /etc/sudoers.d/dev

# Configure SSH daemon
RUN mkdir -p /run/sshd /var/run/sshd && \
    ssh-keygen -A

# Create SSH config
COPY ssh_config /etc/ssh/sshd_config

# Set up npm global directory for dev user and install Claude CLI
USER dev
WORKDIR /home/dev

RUN mkdir -p ~/.npm-global && \
    npm config set prefix ~/.npm-global && \
    npm install -g @anthropic-ai/claude-code || echo "Claude CLI install failed, will retry at runtime"

# Install oh-my-zsh for dev user
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

# Install useful zsh plugins
RUN git clone https://github.com/zsh-users/zsh-autosuggestions ~/.oh-my-zsh/custom/plugins/zsh-autosuggestions && \
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ~/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting

# Create Jupyter config directory (token will be set at runtime)
RUN mkdir -p ~/.jupyter

# Create setup directory with all configs and user home items for copying to persistent disk after mount
USER root
RUN mkdir -p /devserver-setup && \
    cp -r /home/dev/.npm-global /devserver-setup/npm-global && \
    cp -r /home/dev/.oh-my-zsh /devserver-setup/oh-my-zsh && \
    cp -r /home/dev/.jupyter /devserver-setup/jupyter && \
    cp /home/dev/.npmrc /devserver-setup/.npmrc

COPY --chown=root:root shell_env /devserver-setup/.shell_env
COPY --chown=root:root zshrc /devserver-setup/.zshrc
COPY --chown=root:root bashrc /devserver-setup/.bashrc
COPY --chown=root:root bash_profile /devserver-setup/.bash_profile
COPY --chown=root:root profile /devserver-setup/.profile
COPY --chown=root:root zprofile /devserver-setup/.zprofile

# Don't copy to /home/dev since persistent disk will overwrite it
USER dev

# Switch back to root for final configuration
USER root

# Create custom MOTD  
COPY motd_script /usr/local/bin/motd_script
COPY motd_script /etc/update-motd.d/00-custom
RUN chmod +x /usr/local/bin/motd_script && \
    chmod +x /etc/update-motd.d/00-custom && \
    rm -f /etc/motd /etc/legal /usr/share/base-files/motd 2>/dev/null || true && \
    mkdir -p /etc/motd.d /etc/update-motd.d /var/lib/sudo/lectured && \
    touch /etc/motd.d/00-header && \
    chmod 644 /etc/motd.d/00-header && \
    touch /var/lib/sudo/lectured/dev && \
    echo "dev" > /var/lib/sudo/lectured/dev

# Add dotfiles persistence scripts
COPY setup-dotfiles-persistence /usr/local/bin/setup-dotfiles-persistence
COPY backup-dotfiles /usr/local/bin/backup-dotfiles
COPY restore-dotfiles /usr/local/bin/restore-dotfiles
COPY list-dotfile-versions /usr/local/bin/list-dotfile-versions
COPY restore-dotfiles-version /usr/local/bin/restore-dotfiles-version
COPY dotfiles-shutdown-handler /usr/local/bin/dotfiles-shutdown-handler
RUN chmod +x /usr/local/bin/setup-dotfiles-persistence && \
    chmod +x /usr/local/bin/backup-dotfiles && \
    chmod +x /usr/local/bin/restore-dotfiles && \
    chmod +x /usr/local/bin/list-dotfile-versions && \
    chmod +x /usr/local/bin/restore-dotfiles-version && \
    chmod +x /usr/local/bin/dotfiles-shutdown-handler

# Disable PAM MOTD and Ubuntu Pro ads
RUN sed -i 's/session    optional     pam_motd.so/#&/g' /etc/pam.d/sshd 2>/dev/null || true && \
    sed -i 's/session    optional     pam_motd.so  motd=/#&/g' /etc/pam.d/sshd 2>/dev/null || true && \
    rm -rf /etc/update-motd.d/00-header /etc/update-motd.d/10-help-text /etc/update-motd.d/80-esm /etc/update-motd.d/95-hwe-eol 2>/dev/null || true && \
    chmod -x /usr/sbin/update-motd 2>/dev/null || true

# Clean up
RUN apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Set proper permissions
RUN chown -R dev:dev /home/dev && \
    chmod 700 /home/dev/.ssh 2>/dev/null || true

# Expose ports
EXPOSE 22 8888

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep sshd || exit 1

# Default command will be overridden by Kubernetes pod spec
CMD ["/usr/sbin/sshd", "-D", "-e"]