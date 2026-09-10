# Source revisions are immutable. Publish and deploy only a tested image digest.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential autoconf automake libtool libtool-bin pkg-config cmake \
    curl ca-certificates git yasm nasm libssl-dev zlib1g-dev libpcre2-dev \
    libsqlite3-dev libcurl4-openssl-dev libedit-dev libsndfile1-dev libopus-dev \
    libspeex-dev libspeexdsp-dev libtiff-dev libjpeg-dev libpng-dev libldns-dev \
    libavformat-dev libavcodec-dev libswscale-dev libavutil-dev libpq-dev \
    libshout3-dev libmpg123-dev libmp3lame-dev flite1-dev liblua5.2-dev \
    uuid-dev libncurses-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src
ARG SOFIA_REV=ad36ac8f755308e8b87f98a505e83d4e408e5cc3
RUN mkdir sofia && curl -fsSL https://codeload.github.com/freeswitch/sofia-sip/tar.gz/${SOFIA_REV} | tar xz -C sofia --strip-components=1 \
    && cd sofia && ./bootstrap.sh && ./configure --prefix=/usr/local --with-openssl \
    && make -j4 && make install && ldconfig
ARG SPANDSP_REV=8f1e1646bdec99eac5fd2cd92c35563f736b9b89
RUN mkdir spandsp && curl -fsSL https://codeload.github.com/freeswitch/spandsp/tar.gz/${SPANDSP_REV} | tar xz -C spandsp --strip-components=1 \
    && cd spandsp && ./bootstrap.sh && ./configure --prefix=/usr/local \
    && make -j4 && make install && ldconfig
ARG FREESWITCH_REV=ef32e205295e29f034f1453ad245ba5efb07b94a
RUN mkdir freeswitch && curl -fsSL https://codeload.github.com/signalwire/freeswitch/tar.gz/${FREESWITCH_REV} | tar xz -C freeswitch --strip-components=1
COPY modules.conf /usr/src/freeswitch/modules.conf
WORKDIR /usr/src/freeswitch
RUN ./bootstrap.sh -j && ./configure --prefix=/usr --sysconfdir=/etc --localstatedir=/var \
    --with-modinstdir=/usr/lib/freeswitch/mod --with-rundir=/var/run/freeswitch \
    --with-logfiledir=/var/log/freeswitch --with-dbdir=/var/lib/freeswitch/db \
    --with-confdir=/etc/freeswitch --with-soundsdir=/usr/share/freeswitch/sounds \
    --disable-core-pgsql-support && make -j4 && make install \
    && mkdir -p /usr/share/freeswitch/conf/vanilla \
    && cp -a conf/vanilla/. /usr/share/freeswitch/conf/vanilla/ \
    && ldconfig && freeswitch -version
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tzdata libcurl4 libedit2 libopus0 libspeex1 libspeexdsp1 \
    libtiff6 libjpeg62-turbo libpng16-16 libldns3 libsndfile1 libflite1 libshout3 \
    libmpg123-0 libmp3lame0 libssl3 libsqlite3-0 libpcre2-8-0 libncurses6 \
    libuuid1 libstdc++6 zlib1g libavformat59 libavcodec59 libswscale6 libavutil57 \
    libpq5 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/bin/freeswitch /usr/bin/fs_cli /usr/bin/
COPY --from=build /usr/lib/libfreeswitch.so* /usr/lib/
COPY --from=build /usr/lib/freeswitch /usr/lib/freeswitch
COPY --from=build /usr/local/lib/libsofia-sip-ua.so* /usr/local/lib/
COPY --from=build /usr/local/lib/libspandsp.so* /usr/local/lib/
COPY --from=build /usr/share/freeswitch /usr/share/freeswitch
RUN ldconfig && ldd /usr/bin/freeswitch /usr/bin/fs_cli /usr/lib/freeswitch/mod/*.so > /tmp/dependencies \
    && if grep 'not found' /tmp/dependencies; then exit 1; fi \
    && rm /tmp/dependencies && freeswitch -version
CMD ["/usr/bin/freeswitch", "-nc", "-nf", "-nonat"]
