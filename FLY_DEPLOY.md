# Fly.io 部署指南 - AIHub 后端

## 📋 前置准备

1. **Fly.io 账号**：访问 https://fly.io 注册（需要 GitHub 或邮箱）
2. **安装 Fly CLI**：
   - Windows: `iwr https://fly.io/install.ps1 -useb | iex`
   - 或下载安装包: https://github.com/superfly/flyctl/releases

## 🚀 部署步骤

### 步骤1: 登录 Fly.io

```bash
fly auth login
```

会打开浏览器，完成登录。

### 步骤2: 创建应用

```bash
cd server
fly launch --no-deploy
```

**交互提示**：
- App name: 输入 `aihub-backend` 或自定义
- Region: 选择 `nrt` (东京) 或 `hkg` (香港) - 离中国较近
- 会生成 `fly.toml` 文件（已提供）

### 步骤3: 设置环境变量（敏感信息）

```bash
# 设置 DeepSeek API Key（替换为你的真实 Key）
fly secrets set DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY_HERE

# 设置 JWT 密钥（自己生成一个随机字符串）
fly secrets set JWT_SECRET=aihub-fly-2026-secret-$(openssl rand -hex 16)

# 设置 DeepSeek API 地址
fly secrets set DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

### 步骤4: 部署应用

```bash
fly deploy
```

**首次部署会**：
1. 构建 Docker 镜像
2. 推送到 Fly.io 镜像仓库
3. 启动应用

### 步骤5: 查看应用状态

```bash
# 查看应用信息
fly status

# 查看实时日志
fly logs

# 查看应用列表
fly apps list
```

### 步骤6: 获取访问地址

部署成功后，Fly.io 会分配一个 `.fly.dev` 域名：

```
https://aihub-backend.fly.dev
```

**记录下来，下一步配置前端需要！**

---

## 🔧 常用命令

### 查看应用日志
```bash
fly logs -a aihub-backend
```

### 重启应用
```bash
fly machines restart
```

### 停止应用
```bash
fly apps suspend aihub-backend
```

### 删除应用
```bash
fly apps destroy aihub-backend
```

### 打开应用控制台
```bash
fly ssh console
```

### 查看环境变量
```bash
fly secrets list
```

### 删除环境变量
```bash
fly secrets unset DEEPSEEK_API_KEY
```

---

## 🌍 区域选择建议

Fly.io 支持多个区域，选择离用户最近的：

| 区域代码 | 位置 | 推荐度 |
|---------|------|--------|
| nrt     | 东京 | ⭐⭐⭐⭐⭐ (推荐) |
| hkg     | 香港 | ⭐⭐⭐⭐ |
| sin     | 新加坡 | ⭐⭐⭐⭐ |
| icn     | 首尔 | ⭐⭐⭐ |
| lax     | 洛杉矶 | ⭐⭐ |
| sjc     | 圣何塞 | ⭐⭐ |

**修改区域**：编辑 `fly.toml` 中的 `primary_region`

---

## 💰 费用说明

### 免费额度
- **每月 3 台共享 CPU 机器，每台 256MB RAM**
- **每月 160GB 出站流量**
- **3 个小型持久卷（每个 1GB）**

### 付费标准
- 超出免费额度后：$0.02/小时/vCPU, $0.0025/小时/MB RAM
- **如果只是测试，免费额度完全够用**

---

## 🐛 常见问题

### 问题1: 部署失败，提示 "out of memory"

**解决方法**：增加内存配置

编辑 `fly.toml`：
```toml
[[vm]]
  memory_mb = 512  # 改为 512MB
```

重新部署：
```bash
fly deploy
```

### 问题2: 应用自动休眠后响应慢

**原因**：Fly.io 免费套餐会自动停止空闲应用

**解决方法**：
- 方案A：接受首次请求慢（冷启动约 5-10 秒）
- 方案B：付费保持应用常驻（`min_machines_running = 1`）

### 问题3: SQLite 数据库重启后数据丢失

**原因**：Fly.io 容器文件系统是临时的

**解决方法**：
- 使用 Fly Volumes（持久化存储）
- 或迁移到云端数据库（如 Turso、Neon）

**临时方案**（不推荐生产环境）：
数据会丢失，但测试可用。

---

## 🔐 安全建议

1. **不要提交 `.env` 到 Git**
   - 已配置 `.gitignore`

2. **使用 `fly secrets` 管理敏感信息**
   ```bash
   fly secrets set KEY=VALUE
   ```

3. **定期轮换 API Key**
   - 登录 DeepSeek 控制台重新生成

---

## 📦 项目文件说明

```
server/
├── Dockerfile        # Docker 镜像定义
├── .dockerignore     # Docker 构建排除文件
├── fly.toml          # Fly.io 配置文件
├── package.json      # 依赖定义
├── src/
│   └── index.js      # 后端主程序
└── data/             # SQLite 数据库（临时）
```

---

## ✅ 部署检查清单

- [ ] Fly CLI 已安装 (`fly version`)
- [ ] 已登录 Fly.io (`fly auth whoami`)
- [ ] 应用已创建 (`fly apps list`)
- [ ] 环境变量已设置 (`fly secrets list`)
- [ ] 应用已部署 (`fly status`)
- [ ] 可以访问健康检查接口 (`https://your-app.fly.dev/api/health`)
- [ ] 可以访问配置状态接口 (`https://your-app.fly.dev/api/config/status`)

---

## 🎯 下一步

部署成功后：

1. **记录公网 URL**（如 `https://aihub-backend.fly.dev`）
2. **配置前端**（`js/app-real.js` 中的 `API_BASE_URL`）
3. **测试完整功能**
4. **可选：绑定自定义域名**

---

## 📞 需要帮助？

- Fly.io 文档: https://fly.io/docs/
- Fly.io 社区: https://community.fly.io/
- 或告诉我具体错误信息，我帮你调试！
