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

// 种子数据：管理员
const adminExists = db.prepare('SELECT id FROM users WHERE phone = ?').get('13800000000');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123456', 10);
  db.prepare("INSERT INTO users (phone, password_hash, nickname, credits, role) VALUES ('13800000000', ?, '管理员', 999999, 'admin')").run(hash);
  console.log('[DB] Admin created: phone=13800000000 password=admin123456');
}

// 兼容旧表：添加 PayPal 相关字段

try { db.exec('ALTER TABLE orders ADD COLUMN paid_at TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN paypal_order_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE credit_transactions ADD COLUMN related_order_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT'); } catch (e) {}

// 创建高频查询索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
`);

// ===== 中间件 =====
// 支付回调需要原始 body 用于验签，必须在 express.json() 之前挂载
app.use('/api/payment/wechat-notify', express.raw({ type: 'application/json' }));
app.use('/api/payment/alipay-notify', express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// CORS: 限制为前端域名
app.use(require('cors')({
  origin: [
    'https://aihub-frontend-alpha.vercel.app',
    'https://aihub-frontend-pyom.vercel.app',
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:3001',
  ].filter(Boolean),
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

// --- 注册 ---
app.post('/api/auth/register', (req, res) => {
  const { phone, password, nickname } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '手机号和密码必填' });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (exists) return res.status(409).json({ error: '手机号已注册' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (phone, password_hash, nickname, credits) VALUES (?, ?, ?, 50)").run(phone, hash, nickname || '新用户');
  const userId = result.lastInsertRowid;
  db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description) VALUES (?, 'gift', 50, 50, 'system', '新用户注册赠送')").run(userId);
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
  const user = db.prepare('SELECT id, phone, nickname, credits, role FROM users WHERE id = ?').get(userId);
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
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  const safe = { id: user.id, phone: user.phone, nickname: user.nickname, credits: user.credits, role: user.role };
  res.json({ token, user: safe });
});

// --- 当前用户 ---
app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, phone, nickname, credits, role, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// --- 真实对话（SSE流式，接入 DeepSeek API）---
app.post('/api/chat/stream', auth, async (req, res) => {
  const { message, model } = req.body;
  if (!message) return res.status(400).json({ error: '消息不能为空' });

  // 模型计费配置
  const modelRates = {
    'deepseek-chat': 2, 'deepseek-coder': 2, 'deepseek-reasoner': 15,
    'qwen-turbo': 3, 'qwen-plus': 8, 'gpt-4o-mini': 5
  };
  const rate = modelRates[model] || 2;
  const estCost = Math.max(1, rate); // 简化：按次固定扣费

  if (req.user.credits < estCost) {
    return res.status(402).json({ error: '积分不足', code: 'INSUFFICIENT_CREDITS' });
  }

  // 先扣积分
  db.prepare("UPDATE users SET credits = credits - ?, total_consumed = total_consumed + ? WHERE id = ?").run(estCost, estCost, req.user.id);
  db.prepare(
    "INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model) VALUES (?, 'consume', ?, (SELECT credits FROM users WHERE id = ?), 'chat', ?, ?)"
  ).run(req.user.id, -estCost, req.user.id, 'AI对话-' + (model || 'deepseek-chat'), model || 'deepseek-chat');

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // SSE 流中断时返还积分
  let streamClosed = false;
  let creditsRefunded = false;
  req.on('close', () => {
    streamClosed = true;
    // 如果流在完成前关闭且积分未返还，则返还
    if (!creditsRefunded) {
      db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(estCost, req.user.id);
      db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model) VALUES (?, 'refund', ?, (SELECT credits FROM users WHERE id = ?), 'chat', ?, ?)").run(req.user.id, estCost, req.user.id, '流中断返还-' + (model || 'deepseek-chat'), model || 'deepseek-chat');
      console.log('[Chat] Stream closed, credits refunded:', estCost, 'userId:', req.user.id);
    }
  });

  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

    const apiRes = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [{ role: 'user', content: message }],
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      // 返还积分（使用 refund 类型记录，而非 DELETE）
      db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(estCost, req.user.id);
      db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model) VALUES (?, 'refund', ?, (SELECT credits FROM users WHERE id = ?), 'chat', ?, ?)").run(req.user.id, estCost, req.user.id, '对话失败返还-' + (model || 'deepseek-chat'), model || 'deepseek-chat');
      res.write('data: ' + JSON.stringify({ type: 'error', error: 'API错误: ' + apiRes.status + ' ' + errText.slice(0, 300) }) + '\n\n');
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
          creditsRefunded = true; // 正常完成，标记积分已消费（不需要返还）
          const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
          res.write('data: ' + JSON.stringify({ type: 'done', cost: estCost, balance: user.credits }) + '\n\n');
          res.end();
          return;
        }
        try {
          const json = JSON.parse(dataStr);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && delta.content) {
            res.write('data: ' + JSON.stringify({ type: 'token', content: delta.content }) + '\n\n');
          }
        } catch (e) {}
      }
    }
    creditsRefunded = true; // 正常完成流读取，标记积分已消费
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
    res.write('data: ' + JSON.stringify({ type: 'done', cost: estCost, balance: user.credits }) + '\n\n');
    res.end();
  } catch (e) {
    console.error('[Chat] Error:', e.message);
    creditsRefunded = true; // catch 中已返还，标记防止 close 重复返还
    // 返还积分（使用 refund 类型记录，而非 DELETE）
    db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(estCost, req.user.id);
    db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model) VALUES (?, 'refund', ?, (SELECT credits FROM users WHERE id = ?), 'chat', ?, ?)").run(req.user.id, estCost, req.user.id, '对话异常返还-' + (model || 'deepseek-chat'), model || 'deepseek-chat');
    res.write('data: ' + JSON.stringify({ type: 'error', error: '对话失败: ' + e.message }) + '\n\n');
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
require('./payment')(app, db);

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

// --- 管理后台：数据看板 ---
app.get('/api/admin/dashboard', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const stats = {
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalOrders: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='paid'").get().c,
    totalRevenue: db.prepare("SELECT SUM(amount) as s FROM orders WHERE status='paid'").get().s || 0,
  };
  res.json({ stats });
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

// ===== 管理后台：用户列表 =====
app.get('/api/admin/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const users = db.prepare('SELECT id, phone, nickname, credits, role, status, created_at FROM users ORDER BY id DESC LIMIT 100').all();
  res.json({ users });
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
  console.log('[AIHub] Frontend: http://localhost:' + PORT);
  console.log('[AIHub] Admin: phone=13800000000 password=admin123456');
  console.log('[AIHub] Test user: register any phone + password');
});
