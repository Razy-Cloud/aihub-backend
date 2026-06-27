# Fly.io Dockerfile for AIHub Backend
# 使用 Node.js 22 官方镜像

FROM node:22-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖（生产环境）
RUN npm ci --only=production

# 复制源代码
COPY src/ ./src/

# 创建数据目录（SQLite 数据库）
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "src/index.js"]
