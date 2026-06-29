const crypto = require('crypto');
const QRCode = require('qrcode');

// 支付相关配置
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://aihub-frontend-pyom.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || FRONTEND_URL; // 回调必须使用后端地址

const pkgMap = {
  pkg_9: { price: 9.9, credits: 100, name: 'AIHub 体验档' },
  pkg_29: { price: 29.9, credits: 350, name: 'AIHub 入门档' },
  pkg_99: { price: 99, credits: 1200, name: 'AIHub 常用档' },
  pkg_299: { price: 299, credits: 4000, name: 'AIHub 重度档' },
};

// 初始化微信支付客户端
function initWechatPay() {
  if (!process.env.WECHAT_PAY_APP_ID || !process.env.WECHAT_PAY_MCH_ID || !process.env.WECHAT_PAY_PRIVATE_KEY) {
    return null;
  }
  const Pay = require('wechatpay-node-v3');
  return new Pay({
    appid: process.env.WECHAT_PAY_APP_ID,
    mchid: process.env.WECHAT_PAY_MCH_ID,
    serial_no: process.env.WECHAT_PAY_CERT_SERIAL_NO || '',
    privateKey: Buffer.from(process.env.WECHAT_PAY_PRIVATE_KEY.replace(/\\n/g, '\n')),
    key: process.env.WECHAT_PAY_API_V3_KEY || '',
  });
}

// 初始化支付宝客户端
function initAlipay() {
  if (!process.env.ALIPAY_APP_ID || !process.env.ALIPAY_PRIVATE_KEY) {
    return null;
  }
  const AlipaySdk = require('alipay-sdk').default;
  return new AlipaySdk({
    appId: process.env.ALIPAY_APP_ID,
    privateKey: process.env.ALIPAY_PRIVATE_KEY.replace(/\\n/g, '\n'),
    alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY ? process.env.ALIPAY_PUBLIC_KEY.replace(/\\n/g, '\n') : undefined,
    gateway: process.env.ALIPAY_GATEWAY_URL || 'https://openapi.alipay.com/gateway.do',
    signType: 'RSA2',
  });
}

function formatNotifyUrl(baseUrl) {
  return baseUrl.replace(/\/$/, '') + '/api/payment';
}

// 订单到账处理（原子事务）
function createFulfillOrder(db) {
  const updateOrder = db.prepare("UPDATE orders SET status = ?, paid_at = datetime('now','localtime') WHERE id = ?");
  const addCredits = db.prepare('UPDATE users SET credits = credits + ?, total_recharged = total_recharged + ? WHERE id = ?');
  const recordTransaction = db.prepare("INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, related_order_id) VALUES (?, 'recharge', ?, (SELECT credits FROM users WHERE id = ?), 'payment', ?, ?)");

  return db.transaction((orderId, method) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || order.status === 'paid') return { alreadyPaid: true, order };
    updateOrder.run('paid', orderId);
    addCredits.run(order.credits, order.credits, order.user_id);
    recordTransaction.run(order.user_id, order.credits, order.user_id, `${method}充值-${order.package_name}`, orderId);
    return { alreadyPaid: false, order };
  });
}

module.exports = function setupPaymentRoutes(app, db) {
  // 兼容旧表：添加 payment_method 字段
  try { db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT'); } catch (e) {}

  const wxpay = initWechatPay();
  const alipay = initAlipay();
  const fulfillOrder = createFulfillOrder(db);

  // 微信支付：创建 Native 订单
  app.post('/api/payment/create-wechat-order', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'aihub-dev-2026';
    let user;
    try {
      const d = jwt.verify(auth.slice(7), JWT_SECRET);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(d.userId);
    } catch (e) { return res.status(401).json({ error: '登录已过期' }); }
    if (!user) return res.status(401).json({ error: '用户不存在' });

    const { packageId } = req.body;
    const pkg = pkgMap[packageId];
    if (!pkg) return res.status(400).json({ error: '套餐不存在' });
    if (!wxpay) return res.status(400).json({ error: '微信支付未配置' });

    const orderId = 'ORD' + Date.now();
    db.prepare("INSERT INTO orders (id, user_id, package_name, amount, credits, status, payment_method) VALUES (?, ?, ?, ?, ?, 'pending', 'wechat')").run(orderId, user.id, packageId, pkg.price, pkg.credits);

    try {
      const amountFen = Math.round(pkg.price * 100); // 微信金额单位为分
      const result = await wxpay.transactions_native({
        description: pkg.name,
        out_trade_no: orderId,
        notify_url: `${BACKEND_URL}/api/payment/wechat-notify`,
        amount: { total: amountFen },
        scene_info: { payer_client_ip: req.ip || '127.0.0.1' },
      });

      if (!result || result.statusCode !== 200) {
        console.error('[WeChat] 创建订单失败:', result);
        return res.status(500).json({ error: '微信支付订单创建失败', raw: result });
      }

      const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
      const qrDataUrl = await QRCode.toDataURL(body.code_url, { width: 256, margin: 2 });
      res.json({ success: true, orderId, codeUrl: body.code_url, qrDataUrl });
    } catch (e) {
      console.error('[WeChat] 创建订单失败:', e);
      res.status(500).json({ error: '微信支付订单创建失败：' + e.message });
    }
  });

  // 微信支付：回调通知
  app.post('/api/payment/wechat-notify', async (req, res) => {
    try {
      if (!wxpay) {
        console.error('[WeChat] 未配置微信支付');
        return res.status(500).json({ code: 'FAIL', message: '未配置' });
      }
      // 需要 raw body 字符串；在 index.js 中已针对该路由使用 express.raw 前置捕获
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
      const body = JSON.parse(rawBody);
      const headers = req.headers;
      const timestamp = headers['wechatpay-timestamp'];
      const nonce = headers['wechatpay-nonce'];
      const serial = headers['wechatpay-serial'];
      const signature = headers['wechatpay-signature'];

      const valid = await wxpay.verifySign({ timestamp, nonce, body: rawBody, serial, signature });
      if (!valid) {
        console.error('[WeChat] 回调验签失败');
        return res.status(400).json({ code: 'FAIL', message: '验签失败' });
      }

      const { ciphertext, associated_data, nonce: n } = body.resource;
      const decrypted = wxpay.decipher_gcm(ciphertext, associated_data, n);
      const orderId = decrypted.out_trade_no;
      if (decrypted.trade_state === 'SUCCESS') {
        fulfillOrder(orderId, '微信支付');
      }
      res.json({ code: 'SUCCESS', message: '成功' });
    } catch (e) {
      console.error('[WeChat] 回调处理失败:', e);
      res.status(500).json({ code: 'FAIL', message: e.message });
    }
  });

  // 支付宝：创建电脑网站支付订单
  app.post('/api/payment/create-alipay-order', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'aihub-dev-2026';
    let user;
    try {
      const d = jwt.verify(auth.slice(7), JWT_SECRET);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(d.userId);
    } catch (e) { return res.status(401).json({ error: '登录已过期' }); }
    if (!user) return res.status(401).json({ error: '用户不存在' });

    const { packageId } = req.body;
    const pkg = pkgMap[packageId];
    if (!pkg) return res.status(400).json({ error: '套餐不存在' });
    if (!alipay) return res.status(400).json({ error: '支付宝未配置' });

    const orderId = 'ORD' + Date.now();
    db.prepare("INSERT INTO orders (id, user_id, package_name, amount, credits, status, payment_method) VALUES (?, ?, ?, ?, ?, 'pending', 'alipay')").run(orderId, user.id, packageId, pkg.price, pkg.credits);

    try {
      const returnUrl = `${FRONTEND_URL}/#/credits?paid=success&order=${orderId}`;
      const notifyUrl = `${BACKEND_URL}/api/payment/alipay-notify`;
      const payUrl = alipay.pageExec('alipay.trade.page.pay', 'GET', {
        bizContent: {
          out_trade_no: orderId,
          total_amount: pkg.price.toFixed(2),
          subject: pkg.name,
          product_code: 'FAST_INSTANT_TRADE_PAY',
        },
        notifyUrl,
        returnUrl,
      });
      res.json({ success: true, orderId, payUrl });
    } catch (e) {
      console.error('[Alipay] 创建订单失败:', e);
      res.status(500).json({ error: '支付宝订单创建失败：' + e.message });
    }
  });

  // 支付宝：回调通知
  app.post('/api/payment/alipay-notify', async (req, res) => {
    try {
      if (!alipay) {
        console.error('[Alipay] 未配置支付宝');
        return res.send('fail');
      }
      const valid = alipay.checkNotifySign(req.body);
      if (!valid) {
        console.error('[Alipay] 回调验签失败');
        return res.send('fail');
      }
      const orderId = req.body.out_trade_no;
      const tradeStatus = req.body.trade_status;
      if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
        fulfillOrder(orderId, '支付宝');
      }
      res.send('success');
    } catch (e) {
      console.error('[Alipay] 回调处理失败:', e);
      res.send('fail');
    }
  });

  // 通用订单查询（前端轮询）
  app.get('/api/payment/order-status', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'aihub-dev-2026';
    let user;
    try {
      const d = jwt.verify(auth.slice(7), JWT_SECRET);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(d.userId);
    } catch (e) { return res.status(401).json({ error: '登录已过期' }); }
    if (!user) return res.status(401).json({ error: '用户不存在' });

    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: '订单号必填' });

    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, user.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });

    // 如果订单为 pending 且配置了对应渠道，可主动查询第三方支付状态
    if (order.status === 'pending') {
      try {
        if (order.payment_method === 'wechat' && wxpay) {
          const result = await wxpay.query({ out_trade_no: orderId });
          const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
          if (body.trade_state === 'SUCCESS') {
            fulfillOrder(orderId, '微信支付');
            order.status = 'paid';
          }
        } else if (order.payment_method === 'alipay' && alipay) {
          const result = await alipay.exec('alipay.trade.query', { bizContent: { out_trade_no: orderId } });
          if (result.code === '10000' && (result.trade_status === 'TRADE_SUCCESS' || result.trade_status === 'TRADE_FINISHED')) {
            fulfillOrder(orderId, '支付宝');
            order.status = 'paid';
          }
        }
      } catch (e) {
        console.error('[Payment] 主动查询失败:', e.message);
      }
    }

    const userInfo = db.prepare('SELECT credits FROM users WHERE id = ?').get(user.id);
    res.json({ success: true, orderId, status: order.status, balance: userInfo.credits });
  });
};
