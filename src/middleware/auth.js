/**
 * JWT 认证中间件
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database');

// 验证 token
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录', code: 'NO_TOKEN' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const user = db.prepare('SELECT id, phone, email, nickname, avatar, credits, member_level, member_expire_at, role, status FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: '用户不存在', code: 'USER_NOT_FOUND' });
    if (user.status === 'banned') return res.status(403).json({ error: '账号已被封禁', code: 'BANNED' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' });
  }
}

// 可选认证（有 token 就解析，没有也放行）
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), config.jwt.secret);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
      if (user && user.status === 'active') req.user = user;
    } catch (e) { /* ignore */ }
  }
  next();
}

// 管理员权限
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

module.exports = { auth, optionalAuth, adminOnly };
