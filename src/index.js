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
const JWT_SECRET = process.env.JWT_SECRET || 'aihub-dev-2026';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'aihub.db');

// PayPal 配置
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'; // sandbox 或 live

// 确保数据目录
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

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
    status TEXT DEFAULT 'paid',
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

// ===== 中间件 =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('cors')());

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
      // 返还积分
      db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(estCost, req.user.id);
      db.prepare("DELETE FROM credit_transactions WHERE user_id = ? AND type = 'consume' ORDER BY id DESC LIMIT 1").run(req.user.id);
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
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
    res.write('data: ' + JSON.stringify({ type: 'done', cost: estCost, balance: user.credits }) + '\n\n');
    res.end();
  } catch (e) {
    console.error('[Chat] Error:', e.message);
    // 返还积分
    db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(estCost, req.user.id);
    db.prepare("DELETE FROM credit_transactions WHERE user_id = ? AND type = 'consume' ORDER BY id DESC LIMIT 1").run(req.user.id);
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
          return_url: `${process.env.FRONTEND_URL || 'https://aihub-frontend-pyom.vercel.app'}/#/credits?paid=success&order=${orderId}`,
          cancel_url: `${process.env.FRONTEND_URL || 'https://aihub-frontend-pyom.vercel.app'}/#/credits?paid=cancel`,
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
      return res.status(500).json({ error: 'PayPal 捕获失败' });
    }

    // 更新订单状态
    db.prepare('UPDATE orders SET status = ?, paid_at = datetime("now","localtime") WHERE id = ?').run('paid', orderId);
    db.prepare('UPDATE users SET credits = credits + ?, total_recharged = total_recharged + ? WHERE id = ?').run(order.credits, order.credits, order.user_id);
    db.prepare('INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, related_order_id) VALUES (?, "recharge", ?, (SELECT credits FROM users WHERE id = ?), "payment", ?, ?)').run(order.user_id, order.credits, order.user_id, `PayPal 充值-${order.package_name}`, orderId);

    console.log('[PayPal] 订单已到账:', orderId, 'credits:', order.credits);

    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(order.user_id);
    res.json({ success: true, balance: user.credits, message: '支付成功，积分已到账' });
  } catch (e) {
    console.error('[PayPal] 捕获订单失败:', e);
    res.status(500).json({ error: '捕获失败：' + e.message });
  }
});

// --- 模拟支付（直接到账）---
app.post('/api/payment/create-order', auth, (req, res) => {
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
      paypalClientId: paypalReady ? process.env.PAYPAL_CLIENT_ID : '',
      paypalEnv: process.env.PAYPAL_ENV || 'sandbox',
    },
    version: '1.0.0',
  });
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('[AIHub] Server running at http://localhost:' + PORT);
  console.log('[AIHub] Frontend: http://localhost:' + PORT);
  console.log('[AIHub] Admin: phone=13800000000 password=admin123456');
  console.log('[AIHub] Test user: register any phone + password');
});
