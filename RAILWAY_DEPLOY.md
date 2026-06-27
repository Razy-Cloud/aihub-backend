# Railway 部署指南 - AIHub 后端

## 🚀 Railway 部署步骤（无需信用卡）

### 步骤1: 注册 Railway 账号

1. 访问 **https://railway.app**
2. 点击右上角 **"Login"**
3. 选择 **"Login with GitHub"**（推荐）
4. 授权 Railway 访问你的 GitHub

✅ **不需要信用卡！**

---

### 步骤2: 创建新项目

1. 登录后，点击 **"New Project"**
2. 选择 **"Deploy from GitHub repo"**
3. 在列表中找到 **"aihub-backend"** 仓库
4. 点击仓库名称

---

### 步骤3: 配置环境变量

Railway 会自动检测 Node.js 项目，但需要配置环境变量。

1. 点击创建的项目
2. 点击 **"Variables"** 标签
3. 点击 **"Add Variable"**，逐个添加：

| 变量名 | 值 |
|--------|-----|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DEEPSEEK_API_KEY` | `sk-15a97a196c394874a1d805b37d7fc3ae` |
| `JWT_SECRET` | `aihub-railway-2026-secret` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |

**添加方法**：
- 点击 **"Add Variable"**
- 输入 `KEY=VALUE`（如 `NODE_ENV=production`）
- 或分别输入 Key 和 Value

---

### 步骤4: 部署

添加完环境变量后，Railway 会自动开始部署！

**部署过程**（约 1-3 分钟）：
1. 从 GitHub 拉取代码
2. 自动检测 Node.js
3. 运行 `npm install`
4. 运行 `npm start`（即 `node src/index.js`）
5. 启动应用

---

### 步骤5: 获取访问地址

部署成功后：

1. 点击顶部的 **"Settings"** 标签
2. 找到 **"Domains"** 部分
3. 点击 **"Generate Domain"**
4. Railway 会分配一个 `.up.railway.app` 域名

**示例地址**：
```
https://aihub-backend.up.railway.app
```

**记录下来，下一步配置前端需要！**

---

### 步骤6: 验证部署成功

在浏览器访问：
```
https://your-app.up.railway.app/api/config/status
```

应该看到：
```json
{
  "status": "ok",
  "deepseek_configured": true,
  "env_loaded": true
}
```

---

## 📊 查看应用状态

### 查看部署日志
1. 点击项目
2. 点击 **"Deployments"** 标签
3. 点击最新的部署记录
4. 查看实时日志

### 查看应用指标
- CPU 使用率
- 内存使用率
- 网络流量
- 响应时间

---

## 💰 费用说明

### 免费额度
- **$5 免费额度/月**（新账号）
- 如果用了超过 $5，需要付费
- **对于测试和小流量，完全够用**

### 节省费用的方法
1. **应用空闲时会自动休眠**（不收费）
2. **只在使用时计费**
3. **删除不需要的项目**

---

## 🐛 常见问题

### 问题1: 部署失败，提示 "npm install failed"

**可能原因**：`package.json` 有问题

**解决方法**：
1. 检查 `package.json` 是否正确
2. 确保 `start` 脚本存在

---

### 问题2: 应用部署成功，但访问 502 错误

**可能原因**：
- 应用启动失败
- 端口配置错误

**解决方法**：
1. 查看部署日志（Settings → Deployments）
2. 确保应用监听 `process.env.PORT`（已配置）

---

### 问题3: SQLite 数据库重启后数据丢失

**原因**：Railway 容器文件系统是临时的

**临时方案**（测试用）：
接受数据会丢失

**生产方案**：
- 使用 Railway PostgreSQL 插件（需要付费）
- 或迁移到 Turso（SQLite 云服务，有免费额度）

---

## 🎯 部署成功后，下一步

### 1. 记录公网 URL

部署成功后，记下你的公网地址（如 `https://aihub-backend.up.railway.app`）

### 2. 配置前端

修改 `js/app-real.js`，将 `API_BASE_URL` 改为你的 Railway 地址：

```javascript
const API_BASE_URL = 'https://aihub-backend.up.railway.app';
```

### 3. 测试完整功能

- 注册账号
- 登录
- 对话（调用 DeepSeek API）
- 查看积分

---

## 📦 项目文件说明

```
server/
├── railway.json      # Railway 配置文件
├── package.json      # 依赖定义（Railway 自动读取）
├── src/
│   └── index.js      # 后端主程序
└── data/             # SQLite 数据库（临时）
```

---

## 🔧 Railway CLI（可选）

如果你想用命令行部署：

### 安装 Railway CLI

```bash
# Windows (PowerShell)
iwr https://railway.app/install.ps1 -useb | iex

# 或下载安装包
# https://github.com/railwayapp/cli/releases
```

### 登录
```bash
railway login
```

### 部署
```bash
railway up
```

---

## ✅ 部署检查清单

- [ ] Railway 账号已注册
- [ ] GitHub 仓库已连接
- [ ] 环境变量已设置（5 个）
- [ ] 已生成域名（.up.railway.app）
- [ ] 可以访问健康检查接口
- [ ] 可以访问配置状态接口

---

## 📞 需要帮助？

- Railway 文档: https://docs.railway.app/
- 或告诉我具体错误信息，我帮你调试！

---

## 🎉 快速部署（一键式）

如果你想让我生成一键部署命令，告诉我：

1. 你的 Railway 账号邮箱
2. 是否已安装 Railway CLI

我可以帮你写自动化脚本！
