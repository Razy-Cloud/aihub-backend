/**
 * AIHub 数据库初始化 - SQLite
 * 包含全部表结构和种子数据
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('./config');

// 确保数据目录存在
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== 建表 =====
function initSchema() {
  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      credits INTEGER DEFAULT 0,
      member_level TEXT DEFAULT 'normal',  -- normal / month / quarter / year
      member_expire_at TEXT,
      total_recharged REAL DEFAULT 0,
      total_consumed INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user',  -- user / admin
      status TEXT DEFAULT 'active',  -- active / banned
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // 积分交易流水表
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,  -- recharge / consume / refund / gift / sign_in / invite
      amount INTEGER NOT NULL,  -- 正数=增加, 负数=扣除
      balance_after INTEGER,
      source TEXT,  -- 消耗来源: chat / image / video / document / payment
      description TEXT,
      model TEXT,
      tokens_used INTEGER DEFAULT 0,
      related_order_id TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 充值订单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      package_id TEXT NOT NULL,
      package_name TEXT,
      amount REAL NOT NULL,  -- 支付金额(元)
      credits INTEGER NOT NULL,  -- 对应积分
      payment_method TEXT,  -- wechat / alipay / mock
      status TEXT DEFAULT 'pending',  -- pending / paid / failed / refunded
      trade_no TEXT,  -- 第三方支付流水号
      paid_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 对话会话表
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT '新对话',
      model TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 对话消息表
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,  -- user / assistant / system
      content TEXT NOT NULL,
      model TEXT,
      tokens_used INTEGER DEFAULT 0,
      credits_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 签到记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS check_in_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      check_date TEXT NOT NULL,
      consecutive_days INTEGER DEFAULT 1,
      credits_earned INTEGER,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, check_date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 模型配置表 (管理后台可调)
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      tier TEXT NOT NULL,
      rate INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  console.log('[DB] Schema initialized');
}

// ===== 种子数据 =====
function seedData() {
  // 检查是否已有管理员
  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync(config.admin.password, 10);
    db.prepare(`
      INSERT INTO users (phone, password_hash, nickname, credits, role, status)
      VALUES (?, ?, '管理员', 999999, 'admin', 'active')
    `).run(config.admin.phone, hash);
    console.log('[DB] Admin user created:', config.admin.phone);
  }

  // 插入模型配置
  const modelCount = db.prepare('SELECT COUNT(*) as c FROM models').get().c;
  if (modelCount === 0) {
    const models = [
      ['deepseek-chat', 'DeepSeek V3', 'deepseek', 'basic', 2, '高性价比通用大模型', 1],
      ['qwen-turbo', '通义千问 Turbo', 'qwen', 'basic', 2, '阿里通义基础版', 2],
      ['deepseek-coder', 'DeepSeek Coder', 'deepseek', 'advanced', 4, '编程专精模型', 3],
      ['qwen-plus', '通义千问 Plus', 'qwen', 'advanced', 4, '增强版通用模型', 4],
      ['gpt-4o-mini', 'GPT-4o mini', 'openai', 'advanced', 5, 'OpenAI轻量旗舰', 5],
      ['gpt-4o', 'GPT-4o', 'openai', 'flagship', 12, 'OpenAI旗舰模型', 6],
      ['qwen-max', '通义千问 Max', 'qwen', 'flagship', 10, '阿里最强模型', 7],
      ['deepseek-reasoner', 'DeepSeek R1', 'deepseek', 'reasoning', 18, '深度推理模型', 8],
      ['o1-mini', 'o1-mini', 'openai', 'reasoning', 20, 'OpenAI推理模型', 9],
    ];
    const stmt = db.prepare(`
      INSERT INTO models (id, name, provider, tier, rate, description, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    models.forEach(m => stmt.run(...m));
    console.log('[DB] Models seeded:', models.length);
  }
}

// 初始化
initSchema();
seedData();

module.exports = db;
