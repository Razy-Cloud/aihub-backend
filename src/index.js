require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ===== 初始化 =====
const app = express();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[CRITICAL] JWT_SECRET 未设置！请配置环境变量后重启。');
  process.exit(1);
}
if (JWT_SECRET.length < 32 || JWT_SECRET === 'your-secret-key' || JWT_SECRET === 'change-me') {
  console.error('[CRITICAL] JWT_SECRET 太弱或为默认值（长度需≥32字符），请生成强随机密钥后设置到环境变量。');
  console.error('[CRITICAL] 生成密钥示例: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}
// 持久化路径：优先使用 DB_PATH；在 Railway 环境默认使用 /data/aihub.db，便于挂载 Railway Volume
const DB_PATH = process.env.DB_PATH || (process.env.RAILWAY_ENVIRONMENT_NAME ? '/data/aihub.db' : path.join(__dirname, 'data', 'aihub.db'));

// PayPal 配置
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'; // sandbox 或 live

// 确保数据目录
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

console.log('[DB] Database path:', DB_PATH, process.env.RAILWAY_ENVIRONMENT_NAME ? '(Railway)' : '(local)');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== 数据库建表 =====
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    avatar TEXT,
    credits INTEGER DEFAULT 50,
    member_level TEXT DEFAULT 'none',
    member_expire_at TEXT,
    total_recharged INTEGER DEFAULT 0,
    total_consumed INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER,
    source TEXT,
    description TEXT,
    model TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    package_name TEXT,
    amount REAL NOT NULL,
    credits INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新对话',
    model TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    credits_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS check_in_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    check_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, check_date)
  );
`);

// 种子数据：管理员（首次启动时从环境变量读取，之后数据库已有则忽略）
const ADMIN_PHONE = process.env.ADMIN_PHONE || '15915777289';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hmf123456';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;
const adminExists = db.prepare('SELECT id FROM users WHERE phone = ?').get(ADMIN_PHONE);
if (!adminExists) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare("INSERT INTO users (phone, email, email_verified, password_hash, nickname, credits, role) VALUES (?, ?, 1, ?, '管理员', 999999, 'admin')").run(ADMIN_PHONE, ADMIN_EMAIL, hash);
  console.log('[DB] Admin account created for phone:', ADMIN_PHONE);
}

// 兼容旧表迁移
try { db.exec('ALTER TABLE orders ADD COLUMN paid_at TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN paypal_order_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE credit_transactions ADD COLUMN related_order_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0'); } catch (e) {}

// 创建高频查询索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
`);

// ===== 内存存储 =====
const refreshTokens = new Map(); // userId -> { token, expiresAt }
const resetCodes = new Map();    // code -> { phone, expiresAt }
const emailCodes = new Map();    // code -> { email, expiresAt, type }  type: 'register'|'reset'

// ===== 邮件发送器 =====
let transporter = null;
let sendEmail = null;
(function setupEmail() {
  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    try {
      const nodemailer = require('nodemailer');
      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      sendEmail = async function(to, subject, html) {
        await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
      };
      console.log('[Email] SMTP 邮件发送已配置 (' + smtpHost + ')');
    } catch (e) {
      console.warn('[Email] nodemailer 未安装或配置错误:', e.message);
    }
  }
  if (!sendEmail) {
    sendEmail = async function(to, subject, html) {
      console.log('[Email] (DEV) 未配置 SMTP，邮件内容:\n  To:', to, '\n  Subject:', subject);
    };
    console.log('[Email] 未配置 SMTP，邮件将仅打印到控制台（生产环境请配置 SMTP_* 环境变量）');
  }
})();

// ===== 中间件 =====
// 支付回调需要原始 body 用于验签，必须在 express.json() 之前挂载
app.use('/api/payment/wechat-notify', express.raw({ type: 'application/json' }));
app.use('/api/payment/alipay-notify', express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// 安全 Headers（手动实现，避免额外依赖）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
// CORS: 生产环境限制为前端域名白名单，开发环境允许所有来源
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';
app.use(require('cors')({
  origin: isProduction && ALLOWED_ORIGINS.length > 0
    ? ALLOWED_ORIGINS
    : true,
  credentials: true,
}));

// 速率限制（简易版，生产环境建议使用 express-rate-limit）
const rateLimiter = (maxRequests, windowMs) => {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const record = hits.get(key) || { count: 0, start: now };
    if (now - record.start > windowMs) { record.count = 0; record.start = now; }
    record.count++;
    hits.set(key, record);
    if (record.count > maxRequests) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    // 清理过期记录（避免内存泄漏）
    if (hits.size > 10000) {
      for (const [k, v] of hits) { if (now - v.start > windowMs) hits.delete(k); }
    }
    next();
  };
};

app.use('/api/auth/register', rateLimiter(5, 60000));  // 注册：每分钟5次
app.use('/api/auth/login', rateLimiter(10, 60000));     // 登录：每分钟10次
app.use('/api/user/check-in', rateLimiter(3, 60000));   // 签到：每分钟3次
app.use('/api/chat/stream', rateLimiter(30, 60000));    // 对话：每分钟30次
app.use('/api/image/generate', rateLimiter(10, 60000)); // 绘画：每分钟10次
app.use('/api/payment/create-paypal-order', rateLimiter(10, 60000));  // 创建支付：每分钟10次
app.use('/api/payment/capture-paypal-order', rateLimiter(10, 60000)); // 捕获支付：每分钟10次

// 静态文件：前端页面
app.use(express.static(path.join(__dirname, '..')));

// JWT 验证中间件
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
  try {
    const d = jwt.verify(h.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(d.userId);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (user.status === 'banned') return res.status(403).json({ error: '账号已封禁' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: '登录已过期' });
  }
}

// ===== API 路由 =====

// --- 注册（邮箱必填 + 邮箱验证码） ---
app.post('/api/auth/register', (req, res) => {
  const { phone, password, nickname, email, emailCode } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '手机号和密码必填' });
  if (!email) return res.status(400).json({ error: '邮箱必填，用于接收验证码和找回密码' });
  if (!emailCode) return res.status(400).json({ error: '邮箱验证码必填' });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  
  // 验证邮箱验证码
  const stored = emailCodes.get(emailCode);
  if (!stored || stored.email !== email || stored.type !== 'register' || stored.expiresAt < Date.now()) {
    return res.status(400).json({ error: '邮箱验证码无效或已过期' });
  }
  emailCodes.delete(emailCode); // 一次性使用
  
  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (exists) return res.status(409).json({ error: '手机号已注册' });
  const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (emailExists) return res.status(409).json({ error: '该邮箱已被注册' });
  
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (phone, password_hash, nickname, email, email_verified, credits) VALUES (?, ?, ?, ?, 1, 50)").run(phone, hash, nickname || '新用户', email);
  const userId = result.lastInsertRowid;
  db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description) VALUES (?, 'gift', 50, 50, 'system', '新用户注册赠送')").run(userId);
  const user = db.prepare('SELECT id, phone, email, nickname, credits, role FROM users WHERE id = ?').get(userId);
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user });
});

// --- 登录 ---
app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '手机号和密码必填' });
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (user.status === 'banned') return res.status(403).json({ error: '账号已封禁' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: '密码错误' });
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
  // 生成 refresh token（30天有效，存储在内存中）
  const refreshToken = require('crypto').randomBytes(32).toString('hex');
  refreshTokens.set(user.id, { token: refreshToken, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
  const safe = { id: user.id, phone: user.phone, nickname: user.nickname, credits: user.credits, role: user.role };
  res.json({ token, refreshToken, user: safe });
});

// --- 当前用户 ---
app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, phone, email, nickname, credits, role, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// --- 真实对话（SSE流式，多Provider路由 + 差异化计费）---
app.post('/api/chat/stream', auth, async (req, res) => {
  const { message, model } = req.body;
  if (!message) return res.status(400).json({ error: '消息不能为空' });

  const selectedModel = model || 'deepseek-chat';

  // 从 MODEL_CATALOG 读取模型信息和定价
  const modelInfo = MODEL_CATALOG.find(m => m.id === selectedModel);
  const rate = modelInfo ? modelInfo.costPer1k : 2;
  const estCost = Math.max(1, rate);

  // 检查积分
  if (req.user.credits < estCost) {
    return res.status(402).json({ error: '积分不足', code: 'INSUFFICIENT_CREDITS' });
  }

  // --- 对话历史：创建/验证会话 ---
  let sessionId = req.body.sessionId;
  if (sessionId) {
    // 验证会话属于当前用户
    const session = db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
    if (!session) sessionId = null; // 不存在或不属于用户，新建
  }
  if (!sessionId) {
    sessionId = uuidv4();
    const title = message.length > 30 ? message.slice(0, 30) + '...' : message;
    db.prepare('INSERT INTO chat_sessions (id, user_id, title, model) VALUES (?, ?, ?, ?)').run(sessionId, req.user.id, title, selectedModel);
  }
  // 保存用户消息
  db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?)').run(sessionId, req.user.id, 'user', message, selectedModel);
  let aiResponse = '';

  // Provider 路由配置（根据模型自动选择）
  const providerConfigs = {
    deepseek: { apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1') + '/chat/completions' },
    qwen:     { apiKey: process.env.QWEN_API_KEY,     baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1') + '/chat/completions' },
    openai:   { apiKey: process.env.OPENAI_API_KEY,   baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions' },
  };
  const provider = modelInfo ? modelInfo.provider : 'deepseek';
  const pc = providerConfigs[provider] || providerConfigs.deepseek;

  // 检查 API Key 是否配置
  if (!pc.apiKey || pc.apiKey.length < 10 || pc.apiKey.includes('your')) {
    console.warn('[Chat] 模型 %s (provider: %s) 未配置 API Key，使用降级回复', selectedModel, provider);
    const mockReply = '[系统提示] 该模型 (' + (modelInfo ? modelInfo.name : selectedModel) + ') 的 API Key 尚未配置。请在 Railway 环境变量中添加 ' + provider.toUpperCase() + '_API_KEY 后重试。';
    res.write('data: ' + JSON.stringify({ type: 'token', content: mockReply }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'done', cost: 0, balance: req.user.credits }) + '\n\n');
    res.end();
    return;
  }

  // 设置 SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let creditsDeducted = false;  // 防止重复扣分/断连后扣分
  // 客户端断连时，如果还没扣分则不扣
  req.on('close', () => {
    if (!creditsDeducted) {
      console.log('[Chat] 客户端断连，未扣除积分');
    }
  });

  try {
    const apiRes = await fetch(pc.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + pc.apiKey },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: message }],
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      res.write('data: ' + JSON.stringify({ type: 'error', error: 'AI API 错误: ' + apiRes.status + ' ' + errText.slice(0, 300) }) + '\n\n');
      res.end();
      return;
    }

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          // 对话完成，扣除积分
          db.prepare('UPDATE users SET credits = credits - ?, total_consumed = total_consumed + ? WHERE id = ? AND credits >= ?').run(estCost, estCost, req.user.id, estCost);
          db.prepare(
            "INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model) VALUES (?, 'consume', ?, (SELECT credits FROM users WHERE id = ?), 'chat', ?, ?)"
          ).run(req.user.id, -estCost, req.user.id, 'AI对话-' + selectedModel, selectedModel);
          creditsDeducted = true;
          // 保存 AI 回复到对话历史
          db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, model, credits_used) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, req.user.id, 'assistant', aiResponse, selectedModel, estCost);
          const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
          res.write('data: ' + JSON.stringify({ type: 'done', cost: estCost, balance: user.credits, sessionId: sessionId }) + '\n\n');
          res.end();
          return;
        }
        try {
          const json = JSON.parse(dataStr);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && delta.content) {
            aiResponse += delta.content;
            res.write('data: ' + JSON.stringify({ type: 'token', content: delta.content }) + '\n\n');
          }
        } catch (e) {}
      }
    }
    // 流正常结束，扣除积分
    db.prepare('UPDATE users SET credits = credits - ?, total_consumed = total_consumed + ? WHERE id = ? AND credits >= ?').run(estCost, estCost, req.user.id, estCost);
    db.prepare(
      "INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model) VALUES (?, 'consume', ?, (SELECT credits FROM users WHERE id = ?), 'chat', ?, ?)"
    ).run(req.user.id, -estCost, req.user.id, 'AI对话-' + selectedModel, selectedModel);
    creditsDeducted = true;
    // 保存 AI 回复到对话历史
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, model, credits_used) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, req.user.id, 'assistant', aiResponse, selectedModel, estCost);
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
    res.write('data: ' + JSON.stringify({ type: 'done', cost: estCost, balance: user.credits, sessionId: sessionId }) + '\n\n');
    res.end();
  } catch (e) {
    console.error('[Chat] Error:', e.message);
    // 如果有部分 AI 回复，也保存到历史
    if (aiResponse && aiResponse.length > 0) {
      try { db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, model, credits_used) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, req.user.id, 'assistant', aiResponse, selectedModel, estCost); } catch (_) {}
    }
    if (!creditsDeducted) {
      res.write('data: ' + JSON.stringify({ type: 'error', error: '对话失败: ' + e.message }) + '\n\n');
    }
    res.end();
  }
});

// --- 充值套餐 ---
app.get('/api/payment/packages', (req, res) => {
  res.json({
    packages: [
      { id: 'pkg_9', price: 9.9, credits: 100, name: '体验档' },
      { id: 'pkg_29', price: 29.9, credits: 350, name: '入门档' },
      { id: 'pkg_99', price: 99, credits: 1200, name: '常用档' },
      { id: 'pkg_299', price: 299, credits: 4000, name: '重度档' },
    ]
  });
});

// --- PayPal 支付 ---

// 获取 PayPal Access Token
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
  const baseUrl = process.env.PAYPAL_ENV === 'live'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  return data.access_token;
}

// 创建 PayPal 订单
app.post('/api/payment/create-paypal-order', auth, async (req, res) => {
  const { packageId } = req.body;
  const pkgMap = {
    pkg_9: { price: 9.9, credits: 100, name: 'AIHub 体验档' },
    pkg_29: { price: 29.9, credits: 350, name: 'AIHub 入门档' },
    pkg_99: { price: 99, credits: 1200, name: 'AIHub 常用档' },
    pkg_299: { price: 299, credits: 4000, name: 'AIHub 重度档' },
  };
  const pkg = pkgMap[packageId];
  if (!pkg) return res.status(400).json({ error: '套餐不存在' });

  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return res.status(400).json({ error: 'PayPal 未配置，请联系管理员' });
  }

  const orderId = 'ORD' + Date.now();
  db.prepare("INSERT INTO orders (id, user_id, package_name, amount, credits, status) VALUES (?, ?, ?, ?, ?, 'pending')").run(orderId, req.user.id, packageId, pkg.price, pkg.credits);

  try {
    const accessToken = await getPayPalAccessToken();
    const baseUrl = process.env.PAYPAL_ENV === 'live'
      ? 'https://api.paypal.com'
      : 'https://api.sandbox.paypal.com';

    const paypalOrder = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: orderId,
          amount: {
            currency_code: 'USD',
            value: pkg.price.toFixed(2),
          },
          description: `充值 ${pkg.credits} 积分`,
        }],
        application_context: {
          return_url: `${process.env.FRONTEND_URL || 'https://aihub-frontend-alpha.vercel.app'}/#/credits?paid=success&order=${orderId}`,
          cancel_url: `${process.env.FRONTEND_URL || 'https://aihub-frontend-alpha.vercel.app'}/#/credits?paid=cancel`,
        },
      }),
    });

    const paypalData = await paypalOrder.json();

    if (!paypalOrder.ok) {
      console.error('[PayPal] 创建订单失败:', paypalData);
      return res.status(500).json({ error: 'PayPal 订单创建失败' });
    }

    // 保存 PayPal 订单 ID
    db.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ?').run(paypalData.id, orderId);

    res.json({
      success: true,
      orderId,
      paypalOrderId: paypalData.id,
      approveUrl: paypalData.links.find(link => link.rel === 'approve')?.href,
    });
  } catch (e) {
    console.error('[PayPal] 创建订单失败:', e);
    res.status(500).json({ error: '支付创建失败：' + e.message });
  }
});

// 捕获 PayPal 订单
app.post('/api/payment/capture-paypal-order', auth, async (req, res) => {
  let { orderId, paypalOrderId } = req.body;
  if (!orderId && !paypalOrderId) return res.status(400).json({ error: '订单 ID 必填' });

  let order;
  if (orderId) {
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  } else {
    // 通过 PayPal 订单 ID 查找
    order = db.prepare('SELECT * FROM orders WHERE paypal_order_id = ?').get(paypalOrderId);
    if (order) orderId = order.id;
  }

  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status === 'paid') return res.json({ success: true, message: '订单已到账' });

  // 获取 PayPal 订单 ID
  paypalOrderId = order.paypal_order_id;
  if (!paypalOrderId) return res.status(400).json({ error: 'PayPal 订单 ID 不存在' });

  try {
    const accessToken = await getPayPalAccessToken();
    const baseUrl = process.env.PAYPAL_ENV === 'live'
      ? 'https://api.paypal.com'
      : 'https://api.sandbox.paypal.com';

    const captureRes = await fetch(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const captureData = await captureRes.json();

    if (!captureRes.ok) {
      console.error('[PayPal] 捕获订单失败:', captureData);
      const firstDetail = captureData?.details?.[0];
      return res.status(500).json({
        error: 'PayPal 捕获失败',
        paypalStatus: captureData?.status,
        paypalDebugId: captureData?.debug_id,
        paypalIssue: firstDetail?.issue,
        paypalDescription: firstDetail?.description,
        raw: captureData,
      });
    }

    // 更新订单状态（使用事务保证原子性）
    const updateOrder = db.prepare("UPDATE orders SET status = ?, paid_at = datetime('now','localtime') WHERE id = ?");
    const addCredits = db.prepare('UPDATE users SET credits = credits + ?, total_recharged = total_recharged + ? WHERE id = ?');
    const recordTransaction = db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, related_order_id) VALUES (?, 'recharge', ?, (SELECT credits FROM users WHERE id = ?), 'payment', ?, ?)");

    const runCapture = db.transaction((orderId, userId, credits, packageName) => {
      updateOrder.run('paid', orderId);
      addCredits.run(credits, credits, userId);
      recordTransaction.run(userId, credits, userId, `PayPal 充值-${packageName}`, orderId);
    });
    runCapture(orderId, order.user_id, order.credits, order.package_name);

    console.log('[PayPal] 订单已到账:', orderId, 'credits:', order.credits);

    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(order.user_id);
    res.json({ success: true, balance: user.credits, message: '支付成功，积分已到账' });
  } catch (e) {
    console.error('[PayPal] 捕获订单失败:', e);
    res.status(500).json({ error: '捕获失败：' + e.message });
  }
});

// --- 模拟支付（仅开发环境可用）---
app.post('/api/payment/create-order', auth, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: '生产环境不可使用模拟支付' });
  }
  const { packageId } = req.body;
  const pkgMap = { pkg_9: { price: 9.9, credits: 100 }, pkg_29: { price: 29.9, credits: 350 }, pkg_99: { price: 99, credits: 1200 }, pkg_299: { price: 299, credits: 4000 } };
  const pkg = pkgMap[packageId];
  if (!pkg) return res.status(400).json({ error: '套餐不存在' });
  const orderId = 'ORD' + Date.now();
  db.prepare("INSERT INTO orders (id, user_id, package_name, amount, credits, status) VALUES (?, ?, ?, ?, ?, 'paid')").run(orderId, req.user.id, packageId, pkg.price, pkg.credits);
  db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(pkg.credits, req.user.id);
  db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, related_order_id) VALUES (?, 'recharge', ?, (SELECT credits FROM users WHERE id = ?), 'payment', ?, ?)").run(req.user.id, pkg.credits, req.user.id, '充值到账-' + packageId, orderId);
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, orderId, balance: user.credits, message: '支付成功，积分已到账（模拟）' });
});

// --- 微信支付 / 支付宝支付 ---
try {
  require('./payment')(app, db, auth);
} catch (e) {
  console.log('[Payment] 微信/支付宝支付模块未安装，跳过。如需使用请创建 payment.js');
}

// --- 积分流水 ---
app.get('/api/user/transactions', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ items });
});

// --- 签到 ---
app.post('/api/user/check-in', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const exists = db.prepare('SELECT id FROM check_in_records WHERE user_id = ? AND check_date = ?').get(req.user.id, today);
  if (exists) return res.status(400).json({ error: '今天已签到' });
  const credits = 5;
  db.prepare("INSERT INTO check_in_records (user_id, check_date) VALUES (?, ?)").run(req.user.id, today);
  db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(credits, req.user.id);
  db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description) VALUES (?, 'sign_in', ?, (SELECT credits FROM users WHERE id = ?), 'system', ?)").run(req.user.id, credits, req.user.id, '签到奖励');
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
  // 计算连续签到天数
  const records = db.prepare('SELECT check_date FROM check_in_records WHERE user_id = ? ORDER BY check_date DESC').all(req.user.id);
  let consecutiveDays = 1;
  for (let i = 1; i < records.length; i++) {
    const prev = new Date(records[i-1].check_date); prev.setDate(prev.getDate()-1);
    if (prev.toISOString().slice(0,10) === records[i].check_date) consecutiveDays++;
    else break;
  }
  res.json({ success: true, creditsEarned: credits, balance: user.credits, consecutiveDays });
});

// ===== 管理后台：数据看板（增强版） =====
app.get('/api/admin/dashboard', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const stats = {
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    activeUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE status='active'").get().c,
    bannedUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE status='banned'").get().c,
    totalOrders: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='paid'").get().c,
    totalRevenue: db.prepare("SELECT SUM(amount) as s FROM orders WHERE status='paid'").get().s || 0,
    todayRevenue: db.prepare("SELECT SUM(amount) as s FROM orders WHERE status='paid' AND date(paid_at) = date('now','localtime')").get().s || 0,
    totalCreditsConsumed: Math.abs(db.prepare("SELECT SUM(amount) as s FROM credit_transactions WHERE type='consume'").get().s) || 0,
    totalCreditsRecharged: db.prepare("SELECT SUM(amount) as s FROM credit_transactions WHERE type='recharge'").get().s || 0,
    avgCreditsPerUser: db.prepare("SELECT ROUND(AVG(credits),1) as a FROM users WHERE role != 'admin'").get().a || 0,
  };
  // 今日新增用户
  stats.todayNewUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at) = date('now','localtime')").get().c;
  res.json({ stats });
});

// ===== 管理后台：用户列表（增强版，支持搜索和分页） =====
app.get('/api/admin/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { search, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '';
  const params = [];
  if (search) {
    where = 'WHERE phone LIKE ? OR nickname LIKE ? OR email LIKE ?';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(...params).c;
  const users = db.prepare(`SELECT id, phone, email, nickname, credits, total_recharged, total_consumed, role, status, member_level, created_at FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
  res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 管理后台：单用户详情 =====
app.get('/api/admin/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const user = db.prepare('SELECT id, phone, email, nickname, credits, total_recharged, total_consumed, role, status, member_level, member_expire_at, created_at, updated_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
  const transactions = db.prepare('SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(user.id);
  const chatSessions = db.prepare('SELECT COUNT(*) as c FROM chat_sessions WHERE user_id = ?').get(user.id).c;
  res.json({ user, orders, transactions, chatSessions });
});

// ===== 管理后台：修改用户信息 =====
app.put('/api/admin/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) return res.status(404).json({ error: '用户不存在' });
  const { credits, role, status, nickname, email } = req.body;
  const updates = [];
  const params = [];
  if (credits !== undefined) {
    const diff = parseInt(credits) - targetUser.credits;
    updates.push('credits = ?');
    params.push(parseInt(credits));
    // 记录积分变动流水
    if (diff !== 0) {
      const desc = diff > 0 ? '管理员充值' : '管理员扣除';
      db.prepare(`INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description) VALUES (?, ?, ?, ?, 'admin', ?)`)
        .run(targetUser.id, diff > 0 ? 'recharge' : 'consume', Math.abs(diff), parseInt(credits), desc + ' ' + Math.abs(diff) + '积分');
      if (diff > 0) {
        db.prepare('UPDATE users SET total_recharged = total_recharged + ? WHERE id = ?').run(Math.abs(diff), targetUser.id);
      }
    }
  }
  if (role) { updates.push('role = ?'); params.push(role); }
  if (status) { updates.push('status = ?'); params.push(status); }
  if (nickname !== undefined) { updates.push('nickname = ?'); params.push(nickname); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email || null); }
  if (updates.length > 0) {
    updates.push("updated_at = datetime('now','localtime')");
    params.push(targetUser.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT id, phone, email, nickname, credits, total_recharged, total_consumed, role, status, member_level, created_at, updated_at FROM users WHERE id = ?').get(targetUser.id);
  res.json({ success: true, user: updated });
});

// ===== 管理后台：订单列表 =====
app.get('/api/admin/orders', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '';
  const params = [];
  if (status) { where = 'WHERE o.status = ?'; params.push(status); }
  const total = db.prepare(`SELECT COUNT(*) as c FROM orders o ${where}`).get(...params).c;
  const orders = db.prepare(`SELECT o.*, u.phone, u.nickname FROM orders o LEFT JOIN users u ON o.user_id = u.id ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
  res.json({ orders, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 管理后台：利润分析 =====
app.get('/api/admin/profit', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  
  // 收入 = 所有已支付订单的总金额
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='paid'").get().s;
  const todayRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='paid' AND date(paid_at) = date('now','localtime')").get().s;
  const monthRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='paid' AND strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now','localtime')").get().s;

  // 各套餐销量
  const packageSales = db.prepare("SELECT package_name, COUNT(*) as count, SUM(amount) as revenue, SUM(credits) as total_credits FROM orders WHERE status='paid' GROUP BY package_name ORDER BY revenue DESC").all();

  // API 成本估算：基于各模型调用次数 * 市场公开价格
  // DeepSeek: chat=¥0.001/K tokens input, ¥0.002/K tokens output. 每次调用约 2000 input + 500 output = ¥0.003
  // deepseek-reasoner: ¥0.004/K input, ¥0.016/K output. 每次调用约 2000 input + 800 output = ¥0.021
  // 我们按保守估算：平均每次调用 ¥0.005
  const modelUsage = db.prepare(`
    SELECT 
      COALESCE(model, 'deepseek-chat') as model,
      COUNT(*) as calls,
      SUM(ABS(amount)) as credits_consumed
    FROM credit_transactions 
    WHERE type='consume' AND source IN ('chat','image')
    GROUP BY model
    ORDER BY calls DESC
  `).all();

  const modelCostRates = {
    'deepseek-chat': 0.003,
    'deepseek-coder': 0.003,
    'deepseek-reasoner': 0.021,
    'qwen-turbo': 0.002,
    'qwen-plus': 0.005,
    'gpt-4o-mini': 0.01,
    'image': 0.001,  // Pollinations 免费
  };

  let totalApiCost = 0;
  const modelDetails = modelUsage.map(m => {
    const rate = modelCostRates[m.model] || 0.005;
    const cost = m.calls * rate;
    totalApiCost += cost;
    return {
      model: m.model,
      calls: m.calls,
      creditsConsumed: m.credits_consumed,
      unitCost: rate,
      totalCost: Math.round(cost * 100) / 100,
    };
  });

  // 其他成本（Railway 部署约 $5/月 ≈ ¥36/月，按天分摊）
  const infraCostPerDay = 1.2; // ¥1.2/天
  const totalInfraCost = 0; // 目前运行天数未知，先不计
  const estimatedProfit = totalRevenue - totalApiCost;
  const profitMargin = totalRevenue > 0 ? ((estimatedProfit / totalRevenue) * 100).toFixed(1) : '0';

  // 按时段统计（最近12个月）
  const monthlyRevenue = db.prepare(`
    SELECT strftime('%Y-%m', paid_at) as month, 
           COUNT(*) as orders, 
           SUM(amount) as revenue,
           SUM(credits) as credits_sold
    FROM orders WHERE status='paid' AND paid_at IS NOT NULL
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();

  // 积分消耗统计（按来源）
  const creditConsumption = db.prepare(`
    SELECT source, COUNT(*) as count, SUM(ABS(amount)) as credits
    FROM credit_transactions WHERE type='consume'
    GROUP BY source ORDER BY credits DESC
  `).all();

  res.json({
    revenue: {
      total: totalRevenue,
      today: todayRevenue,
      month: monthRevenue,
    },
    apiCost: {
      total: Math.round(totalApiCost * 100) / 100,
      perCall: Math.round((totalApiCost / (modelUsage.reduce((s, m) => s + m.calls, 0) || 1)) * 10000) / 10000,
      details: modelDetails,
    },
    profit: {
      gross: Math.round(estimatedProfit * 100) / 100,
      margin: parseFloat(profitMargin),
    },
    packageSales,
    monthlyRevenue,
    creditConsumption,
    pricing: {
      packages: [
        { id: 'pkg_9', price: 9.9, credits: 100, costPerCredit: 0.099 },
        { id: 'pkg_29', price: 29.9, credits: 350, costPerCredit: 0.085 },
        { id: 'pkg_99', price: 99, credits: 1200, costPerCredit: 0.082 },
        { id: 'pkg_299', price: 299, credits: 4000, costPerCredit: 0.075 },
      ],
      apiCostPerCreditAvg: Math.round((totalApiCost / (modelUsage.reduce((s, m) => s + m.credits_consumed, 0) || 1)) * 100000) / 100000,
    }
  });
});

// PayPal Client ID 专用接口（前端加载 PayPal SDK 时使用）
app.get('/api/payment/paypal-config', (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(400).json({ error: 'PayPal 未配置' });
  }
  res.json({ clientId: PAYPAL_CLIENT_ID, env: PAYPAL_ENV });
});

// ===== AI 绘画接口 =====
// 使用 Pollinations 免费 API（无需 Key，生产环境建议换成 Stability AI / Replicate）
app.post('/api/image/generate', auth, async (req, res) => {
  const { prompt, style = 'photorealistic', size = '512x512' } = req.body;
  if (!prompt || prompt.trim().length < 2) return res.status(400).json({ error: '请输入绘画描述' });

  // 积分扣费（标准 8 积分/张）
  const cost = 8;
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
  if (user.credits < cost) return res.status(400).json({ error: '积分不足，需要 ' + cost + ' 积分' });

  try {
    // 解析尺寸
    const [w, h] = size.split('x').map(Number);
    const width = w || 512;
    const height = h || 512;

    // 风格映射
    const styleMap = {
      photorealistic: 'flux',
      anime: 'anime',
      oilpainting: 'flux',
      watercolor: 'flux',
      cyberpunk: 'flux',
    };
    const model = styleMap[style] || 'flux';

    // 构建 Pollinations URL
    const encodedPrompt = encodeURIComponent(prompt.trim());
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=${model}&nologo=true&private=true`;

    // 扣积分
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(cost, req.user.id);
    db.prepare(
      "INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description) VALUES (?, 'consume', ?, (SELECT credits FROM users WHERE id = ?), 'system', ?)"
    ).run(req.user.id, -cost, req.user.id, `AI绘画：${prompt.slice(0, 30)}`);

    const balance = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id).credits;

    res.json({
      success: true,
      imageUrl,
      prompt: prompt.trim(),
      style,
      size,
      cost,
      balance,
    });
  } catch (e) {
    console.error('Image generate error:', e);
    res.status(500).json({ error: '绘画生成失败：' + e.message });
  }
});

// 系统状态（前端用来判断哪些功能可用）
app.get('/api/config/status', (req, res) => {
  const paypalReady = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  res.json({
    mockMode: !(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.length > 10),
    providers: {
      deepseek: !!(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.length > 10),
      qwen: !!(process.env.QWEN_API_KEY && process.env.QWEN_API_KEY.length > 10),
      openai: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 10),
      image: true,  // Pollinations 免费 API 已接入
    },
    payment: {
      wechat: !!(process.env.WECHAT_PAY_APP_ID),
      alipay: !!(process.env.ALIPAY_APP_ID),
      paypal: paypalReady,
      paypalEnv: process.env.PAYPAL_ENV || 'sandbox',
      mock: process.env.NODE_ENV !== 'production', // 仅开发环境可使用模拟支付
    },
    version: '1.0.0',
  });
});

// --- 对话历史管理 ---

// 获取用户的对话会话列表
app.get('/api/conversations', auth, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const sessions = db.prepare(
    'SELECT s.id, s.title, s.model, s.created_at, (SELECT COUNT(*) FROM chat_messages WHERE session_id = s.id) as msg_count FROM chat_sessions s WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ? OFFSET ?'
  ).all(req.user.id, parseInt(limit), offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM chat_sessions WHERE user_id = ?').get(req.user.id).c;
  res.json({ success: true, sessions, total, page: parseInt(page), limit: parseInt(limit) });
});

// 创建新对话（空会话，前端可预创建）
app.post('/api/conversations', auth, (req, res) => {
  const { title } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)').run(id, req.user.id, title || '新对话');
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  res.json({ success: true, session });
});

// 获取指定对话的消息列表
app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: '对话不存在' });
  const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ success: true, session, messages });
});

// 删除对话及其所有消息
app.delete('/api/conversations/:id', auth, (req, res) => {
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: '对话不存在' });
  db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: '对话已删除' });
});

// --- Token 刷新 ---

// 用 refresh_token 换新的 access_token（轮换机制）
app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken 必填' });
  let matchedUserId = null;
  for (const [uid, rt] of refreshTokens.entries()) {
    if (rt.token === refreshToken && rt.expiresAt > Date.now()) {
      matchedUserId = uid;
      break;
    }
  }
  if (!matchedUserId) return res.status(401).json({ error: 'refresh token 无效或已过期' });
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(matchedUserId);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  const newToken = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
  // 轮换 refresh token
  const newRefreshToken = require('crypto').randomBytes(32).toString('hex');
  refreshTokens.set(user.id, { token: newRefreshToken, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
  res.json({ success: true, token: newToken, refreshToken: newRefreshToken });
});

// --- 邮箱验证码（统一入口：注册验证 + 密码重置） ---
app.post('/api/auth/send-email-code', async (req, res) => {
  const { email, type } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!['register', 'reset'].includes(type)) return res.status(400).json({ error: 'type 必须是 register 或 reset' });
  
  if (type === 'register') {
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return res.status(409).json({ error: '该邮箱已被注册' });
  } else {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ error: '该邮箱未注册' });
  }
  
  // 生成6位验证码（5分钟有效）
  const code = String(Math.floor(100000 + Math.random() * 900000));
  emailCodes.set(code, { email, type, expiresAt: Date.now() + 5 * 60 * 1000 });
  
  const subject = type === 'register' ? 'AIHub 注册验证码' : 'AIHub 密码重置验证码';
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:8px">
    <h2 style="color:#6366f1;margin:0 0 16px">✦ AIHub</h2>
    <p style="font-size:16px;color:#333">您的验证码是：</p>
    <div style="background:#f5f3ff;padding:16px;border-radius:8px;text-align:center;margin:16px 0">
      <span style="font-size:32px;font-weight:bold;color:#6366f1;letter-spacing:8px">${code}</span>
    </div>
    <p style="font-size:13px;color:#999">验证码 5 分钟内有效，请勿泄露给他人。</p>
    ${type === 'register' ? '<p style="font-size:13px;color:#666">注册成功后赠送 50 积分，即刻体验 AI 对话！</p>' : ''}
  </div>`;
  
  try {
    await sendEmail(email, subject, html);
    console.log('[Auth] 邮件验证码已发送:', email, 'type:', type, 'code:', code);
    if (process.env.NODE_ENV === 'production') {
      res.json({ success: true, message: '验证码已发送到您的邮箱' });
    } else {
      res.json({ success: true, message: '验证码已发送', code }); // 开发环境返回验证码
    }
  } catch (e) {
    console.error('[Auth] 邮件发送失败:', e.message);
    res.status(500).json({ error: '邮件发送失败，请稍后重试' });
  }
});

// --- 忘记密码（支持邮箱或手机号验证码） ---

// 发送手机验证码（短信，保留兼容）
app.post('/api/auth/send-code', (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(404).json({ error: '该手机号未注册' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set(code, { phone, expiresAt: Date.now() + 5 * 60 * 1000 });
  console.log('[Auth] 短信验证码 (DEV): phone=' + phone + ' code=' + code);
  if (process.env.NODE_ENV === 'production') {
    res.json({ success: true, message: '验证码已发送' });
  } else {
    res.json({ success: true, message: '验证码已发送', code });
  }
});

// 重置密码（支持邮箱验证码 或 手机验证码）
app.post('/api/auth/reset-password', (req, res) => {
  const { phone, email, code, newPassword } = req.body;
  if (!code || !newPassword) return res.status(400).json({ error: '验证码和新密码缺一不可' });
  if (newPassword.length < 6) return res.status(400).json({ error: '密码至少6位' });
  
  let targetPhone = phone;
  let targetEmail = email;
  
  // 先尝试邮箱验证码
  if (targetEmail) {
    const stored = emailCodes.get(code);
    if (!stored || stored.email !== targetEmail || stored.type !== 'reset' || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: '邮箱验证码无效或已过期' });
    }
    emailCodes.delete(code);
  } else if (targetPhone) {
    // 再尝试短信验证码
    const stored = resetCodes.get(code);
    if (!stored || stored.phone !== targetPhone || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }
    resetCodes.delete(code);
  } else {
    return res.status(400).json({ error: '请提供手机号或邮箱' });
  }
  
  const hash = bcrypt.hashSync(newPassword, 10);
  if (targetEmail) {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\',\'localtime\') WHERE email = ?').run(hash, targetEmail);
  } else {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\',\'localtime\') WHERE phone = ?').run(hash, targetPhone);
  }
  res.json({ success: true, message: '密码重置成功，请重新登录' });
});

// 模型列表（根据已配置的提供商动态返回）
const MODEL_CATALOG = [
  // DeepSeek
  { id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek', tier: 'basic', tierLabel: '入门档', costPer1k: 2, desc: '高性价比通用大模型，适合日常对话与写作', icon: '🧠' },
  { id: 'deepseek-coder', name: 'DeepSeek Coder', provider: 'deepseek', tier: 'advanced', tierLabel: '进阶档', costPer1k: 4, desc: '代码专用模型，支持多种编程语言', icon: '💻' },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek', tier: 'reasoning', tierLabel: '推理档', costPer1k: 18, desc: '深度推理模型，适合复杂数学与逻辑', icon: '🔬' },
  // Qwen
  { id: 'qwen-turbo', name: '通义千问 Turbo', provider: 'qwen', tier: 'basic', tierLabel: '入门档', costPer1k: 2, desc: '通义千问快速版，性价比高', icon: '🧠' },
  { id: 'qwen-plus', name: '通义千问 Plus', provider: 'qwen', tier: 'advanced', tierLabel: '进阶档', costPer1k: 4, desc: '通义千问增强版，中文理解能力强', icon: '⚡' },
  { id: 'qwen-max', name: '通义千问 Max', provider: 'qwen', tier: 'flagship', tierLabel: '旗舰档', costPer1k: 10, desc: '通义千问旗舰模型，能力全面', icon: '🏆' },
  // OpenAI
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', tier: 'advanced', tierLabel: '进阶档', costPer1k: 5, desc: 'OpenAI 轻量级模型，响应快速', icon: '⚡' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tier: 'flagship', tierLabel: '旗舰档', costPer1k: 12, desc: 'OpenAI 旗舰多模态模型，能力全面', icon: '🏆' },
];
app.get('/api/models', (req, res) => {
  const hasDeepSeek = !!(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.length > 10);
  const hasQwen = !!(process.env.QWEN_API_KEY && process.env.QWEN_API_KEY.length > 10);
  const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 10);
  const enabledProviders = new Set();
  if (hasDeepSeek) enabledProviders.add('deepseek');
  if (hasQwen) enabledProviders.add('qwen');
  if (hasOpenAI) enabledProviders.add('openai');
  const models = MODEL_CATALOG.filter(m => enabledProviders.has(m.provider));
  res.json({ success: true, models });
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 全局错误处理中间件
app.use((err, req, res, next) => {
  console.error('[Error] Unhandled:', err.message);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('[AIHub] Server running at http://localhost:' + PORT);
  if (process.env.NODE_ENV !== 'production') {
    console.log('[AIHub] Admin phone:', ADMIN_PHONE, '(dev mode only)');
  } else {
    console.log('[AIHub] Running in production mode');
  }
  console.log('[AIHub] Test user: register any phone + password');
});
