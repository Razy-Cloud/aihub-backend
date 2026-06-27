/**
 * 积分服务 - 所有积分变动都经过这里，保证事务一致性
 */
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

/**
 * 扣除积分（事务操作）
 * @param {number} userId
 * @param {number} amount - 正数，表示要扣除的量
 * @param {string} source - chat / image / video / document
 * @param {object} extra - { model, tokens_used, description }
 * @returns {{ success: boolean, balance: number, error?: string }}
 */
function deductCredits(userId, amount, source, extra = {}) {
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!user) return { success: false, error: '用户不存在' };
  if (user.credits < amount) return { success: false, error: '积分不足', code: 'INSUFFICIENT_CREDITS' };

  const txn = db.transaction(() => {
    // 扣减余额
    const newBalance = user.credits - amount;
    db.prepare('UPDATE users SET credits = ?, total_consumed = total_consumed + ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(newBalance, amount, userId);

    // 记录流水
    db.prepare(`
      INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, model, tokens_used)
      VALUES (?, 'consume', ?, ?, ?, ?, ?, ?)
    `).run(userId, -amount, newBalance, source, extra.description || `${source}消耗`, extra.model || null, extra.tokens_used || 0);

    return newBalance;
  });

  const balance = txn();
  return { success: true, balance };
}

/**
 * 返还积分（调用失败时）
 */
function refundCredits(userId, amount, source, description = '调用失败返还') {
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!user) return { success: false };

  const txn = db.transaction(() => {
    const newBalance = user.credits + amount;
    db.prepare('UPDATE users SET credits = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(newBalance, userId);

    db.prepare(`
      INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description)
      VALUES (?, 'refund', ?, ?, ?, ?)
    `).run(userId, amount, newBalance, source, description);

    return newBalance;
  });

  const balance = txn();
  return { success: true, balance };
}

/**
 * 充值到账
 */
function rechargeCredits(userId, amount, orderId, description = '充值到账') {
  const user = db.prepare('SELECT credits, total_recharged FROM users WHERE id = ?').get(userId);
  if (!user) return { success: false };

  const txn = db.transaction(() => {
    const newBalance = user.credits + amount;
    db.prepare('UPDATE users SET credits = ?, total_recharged = total_recharged + ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(newBalance, amount / 10, userId); // total_recharged 以元为单位近似

    db.prepare(`
      INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description, related_order_id)
      VALUES (?, 'recharge', ?, ?, 'payment', ?, ?)
    `).run(userId, amount, newBalance, description, orderId);

    return newBalance;
  });

  const balance = txn();
  return { success: true, balance };
}

/**
 * 赠送积分
 */
function giftCredits(userId, amount, description = '系统赠送') {
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!user) return { success: false };

  const txn = db.transaction(() => {
    const newBalance = user.credits + amount;
    db.prepare('UPDATE users SET credits = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(newBalance, userId);

    db.prepare(`
      INSERT INTO credit_transactions (user_id, type, amount, balance_after, source, description)
      VALUES (?, 'gift', ?, ?, 'system', ?)
    `).run(userId, amount, newBalance, description);

    return newBalance;
  });

  const balance = txn();
  return { success: true, balance };
}

/**
 * 预估对话消耗积分
 */
function estimateChatCost(model, inputTokens, outputTokens) {
  const pricing = config_modelPricing(model);
  if (!pricing) return 0;
  const totalTokens = (inputTokens || 0) + (outputTokens || 0);
  return Math.ceil(totalTokens / 1000 * pricing.rate);
}

function config_modelPricing(model) {
  const models = {
    'deepseek-chat': { rate: 2 },
    'qwen-turbo': { rate: 2 },
    'deepseek-coder': { rate: 4 },
    'qwen-plus': { rate: 4 },
    'gpt-4o-mini': { rate: 5 },
    'gpt-4o': { rate: 12 },
    'qwen-max': { rate: 10 },
    'deepseek-reasoner': { rate: 18 },
    'o1-mini': { rate: 20 },
  };
  return models[model];
}

/**
 * 获取用户交易流水
 */
function getTransactions(userId, { page = 1, pageSize = 20, type } = {}) {
  const offset = (page - 1) * pageSize;
  let query = 'SELECT * FROM credit_transactions WHERE user_id = ?';
  const params = [userId];
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  const items = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM credit_transactions WHERE user_id = ?' + (type ? ' AND type = ?' : ''))
    .get(...(type ? [userId, type] : [userId])).c;

  return { items, total, page, pageSize };
}

module.exports = {
  deductCredits,
  refundCredits,
  rechargeCredits,
  giftCredits,
  estimateChatCost,
  getTransactions,
};
