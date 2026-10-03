# 三级液位 PID 云仿真：多阶段构建，运行镜像只带 Node + 仿真内核
# 构建阶段编译 C++ 内核，运行阶段不保留 g++，镜像更小。

FROM node:20-bookworm AS engine-builder
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update; \
    DEBIAN_FRONTEND=noninteractive apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      install -y --no-install-recommends g++; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY native ./native
COPY native-hx ./native-hx
RUN mkdir -p /out \
 && g++ -O2 -std=c++17 -Wall -Wextra -static-libstdc++ -static-libgcc \
      -o /out/YunEngine \
      native/engine.cpp native/model.cpp native/pid.cpp native/score.cpp \
 && g++ -O2 -std=c++17 -Wall -Wextra -static-libstdc++ -static-libgcc \
      -o /out/HxEngine \
      native-hx/engine-hx.cpp native-hx/hx_model.cpp native-hx/hx_score.cpp native/pid.cpp

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    YUN_DATA_DIR=/app/data
WORKDIR /app
COPY --from=engine-builder /out/YunEngine ./bin/YunEngine
COPY --from=engine-builder /out/HxEngine ./bin/HxEngine
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chmod +x ./bin/YunEngine ./bin/HxEngine
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.js"]
