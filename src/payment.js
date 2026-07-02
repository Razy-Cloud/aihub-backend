/**
 * payment.js — 微信支付 / 支付宝支付模块
 * ==========================================
 * 当前为占位骨架。接入真实支付需要：
 *   1. 微信商户平台申请 Native 支付 (https://pay.weixin.qq.com)
 *   2. 支付宝开放平台申请当面付/电脑网站支付 (https://open.alipay.com)
 *   3. 配置环境变量：WECHAT_APP_ID, WECHAT_MCH_ID, WECHAT_API_KEY 等
 *   4. 配置环境变量：ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY, ALIPAY_PUBLIC_KEY 等
 *
 * 当前行为：返回"支付功能即将上线"提示，不处理实际扣款。
 */

const { v4: uuidv4 } = require('uuid');

module.exports = function (app, db, auth) {

  // ========== 微信支付 ==========

  // 创建微信支付 Native 订单（返回二维码链接）
  app.post('/api/payment/create-wechat-order', auth, async (req, res) => {
    const { packageId } = req.body;
    if (!packageId) return res.status(400).json({ error: 'packageId 必填' });

    const packages = {
      pkg_9:   { price: 9.9,  credits: 100,  name: '体验档' },
      pkg_29:  { price: 29.9, credits: 350,  name: '入门档' },
      pkg_99:  { price: 99,   credits: 1200, name: '常用档' },
      pkg_299: { price: 299,  credits: 4000, name: '重度档' },
    };
    const pkg = packages[packageId];
    if (!pkg) return res.status(400).json({ error: '无效的套餐' });

    const wechatReady = !!(process.env.WECHAT_APP_ID && process.env.WECHAT_MCH_ID && process.env.WECHAT_API_KEY);

    if (!wechatReady) {
      return res.json({
        success: true,
        message: '微信支付即将上线，当前请使用 PayPal 支付或联系客服',
        comingSoon: true,
      });
    }

    // TODO: 真实微信支付 Native 下单逻辑
    // 1. 调用统一下单 API：POST https://api.mch.weixin.qq.com/v3/pay/transactions/native
    // 2. 签名：使用商户私钥签名
    // 3. 返回 code_url（可转二维码）
    // 4. 数据库记录订单（status: 'pending', payment_method: 'wechat'）

    const orderId = 'wx_' + uuidv4().slice(0, 12);
    db.prepare(
      "INSERT INTO orders (id, user_id, package_name, amount, credits, status, payment_method) VALUES (?, ?, ?, ?, ?, 'pending', 'wechat')"
    ).run(orderId, req.user.id, packageId, pkg.price, pkg.credits);

    res.json({
      success: true,
      orderId,
      amount: pkg.price,
      // codeUrl: 'weixin://wxpay/bizpayurl?pr=...',  // TODO: 真实返回
      message: '微信支付即将上线，当前请使用 PayPal 支付',
      comingSoon: true,
    });
  });

  // 微信支付回调通知（支付结果推送）
  app.post('/api/payment/wechat-notify', (req, res) => {
    // TODO: 验签 + 更新订单状态
    // 1. 验证签名
    // 2. 解密通知数据
    // 3. 更新订单 status = 'paid'
    // 4. 给用户加积分
    // 5. 返回成功应答给微信
    console.log('[WechatNotify] Received callback (not implemented)');
    res.json({ code: 'SUCCESS', message: 'OK' });
  });

  // 查询微信支付订单状态
  app.get('/api/payment/order-status/:id', auth, (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    res.json({ success: true, order: { id: order.id, status: order.status, amount: order.amount, credits: order.credits } });
  });

  // ========== 支付宝支付 ==========

  // 创建支付宝电脑网站支付订单
  app.post('/api/payment/create-alipay-order', auth, async (req, res) => {
    const { packageId } = req.body;
    if (!packageId) return res.status(400).json({ error: 'packageId 必填' });

    const packages = {
      pkg_9:   { price: 9.9,  credits: 100,  name: '体验档' },
      pkg_29:  { price: 29.9, credits: 350,  name: '入门档' },
      pkg_99:  { price: 99,   credits: 1200, name: '常用档' },
      pkg_299: { price: 299,  credits: 4000, name: '重度档' },
    };
    const pkg = packages[packageId];
    if (!pkg) return res.status(400).json({ error: '无效的套餐' });

    const alipayReady = !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY);

    if (!alipayReady) {
      return res.json({
        success: true,
        message: '支付宝支付即将上线，当前请使用 PayPal 支付或联系客服',
        comingSoon: true,
      });
    }

    // TODO: 真实支付宝电脑网站支付下单逻辑
    // 1. 调用 alipay.trade.page.pay（统一收单下单并支付页面接口）
    // 2. 签名：使用应用私钥签名请求参数
    // 3. 返回支付页面 URL

    const orderId = 'ali_' + uuidv4().slice(0, 12);
    db.prepare(
      "INSERT INTO orders (id, user_id, package_name, amount, credits, status, payment_method) VALUES (?, ?, ?, ?, ?, 'pending', 'alipay')"
    ).run(orderId, req.user.id, packageId, pkg.price, pkg.credits);

    res.json({
      success: true,
      orderId,
      amount: pkg.price,
      // payUrl: 'https://openapi.alipay.com/gateway.do?...',  // TODO: 真实返回
      message: '支付宝支付即将上线，当前请使用 PayPal 支付',
      comingSoon: true,
    });
  });

  // 支付宝支付回调通知（同步/异步）
  app.post('/api/payment/alipay-notify', (req, res) => {
    // TODO: 验签 + 更新订单状态
    // 1. 验证签名
    // 2. 检查 trade_status 是否为 TRADE_SUCCESS
    // 3. 更新订单 status = 'paid'
    // 4. 给用户加积分
    console.log('[AlipayNotify] Received callback (not implemented)');
    res.send('success');
  });

  console.log('[Payment] 微信/支付宝支付模块已加载（骨架模式：待接入真实 API）');
};
