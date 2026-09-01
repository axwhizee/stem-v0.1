# ============================================================
# stem Dockerfile —— 1.0 发布镜像（WebUIShell 服务形态）
#
# 用法（项目数据 = 配置 + SQLite 个体层持久化，全部落 volume）：
#   docker build -t stem:1.0 .
#   docker run -d -p 4321:4321 -v stem-data:/data --name stem stem:1.0
#   浏览器打开 http://localhost:4321
#
# 安全模型（与 bash 工具"无 ask、无沙箱"配套，README 同步说明）：
#   **容器即边界**——挂载的 /data volume 就是 bash 工具的爆炸半径；
#   非 root 用户运行；API key 经环境变量注入，绝不写入镜像/配置。
# ============================================================

# node >= 23.4：node:sqlite 免 flag（个体层持久化硬依赖）。
FROM node:24-slim

# tsx 是运行期依赖（无扩展名相对导入 + .stem/tools/*.ts 动态 import），
# 已列入 package.json dependencies，--omit=dev 不会剔除。
ENV NODE_ENV=production \
    STEM_PROJECT_ROOT=/data \
    STEM_HOST=0.0.0.0 \
    PORT=4321

WORKDIR /app

# 依赖层（利用缓存：仅 package*.json 变化时重装）。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 应用层（源码直跑，原型阶段不引入 tsc 产物链）。
COPY src/ ./src/
COPY shell/ ./shell/
COPY extension/ ./extension/
COPY templates/ ./templates/

# 非 root：node 镜像自带 user 'node'；/data 属主交给它（volume 首启初始化）。
USER node
RUN mkdir -p /data

# 首次启动 runInit 在 /data/.stem 自举默认配置；SQLite 落 /data/.stem/stem.db。
VOLUME ["/data"]
EXPOSE 4321

# HEALTHCHECK 打 /api/health（node 内置 fetch，slim 镜像无 curl 亦可）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "shell/webui/server.ts"]
