FROM nvidia/cuda:11.2.0-devel-ubuntu20.04
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get upgrade -y && apt-get install -y software-properties-common wget
RUN apt-add-repository ppa:git-core/ppa
RUN wget -O - https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add -
RUN apt-add-repository "deb http://apt.llvm.org/focal/ llvm-toolchain-focal-11 main"
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git python3-dev python3-pip python3-setuptools python3-wheel build-essential time \
    cmake clang-11 lld ninja-build libomp-11-dev llvm-11 llvm-11-dev libclang-11-dev && \
    apt-get clean && \
    update-alternatives --install /usr/bin/clang clang /usr/bin/clang-11 1000 && \
    update-alternatives --install /usr/bin/clang++ clang++ /usr/bin/clang++-11 1000

# Build include-what-you-use
RUN git clone https://github.com/include-what-you-use/include-what-you-use && \
    git -C include-what-you-use checkout clang_11 && \
    mkdir iwyu-build && cd iwyu-build && \
    cmake ../include-what-you-use -G Ninja -DCMAKE_PREFIX_PATH=/usr/lib/llvm-11/share && \
    cmake --build .
