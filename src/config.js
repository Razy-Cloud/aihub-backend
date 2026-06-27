/**
 * AIHub 后端配置中心
 */
require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,

  jwt: {
    secret: process.env.JWT_SECRET || 'default-dev-secret',
    expiresIn: process.env.JWT_EXPIRES || '7d',
  },

  // 大模型 API 配置
  llm: {
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    },
    qwen: {
      apiKey: process.env.QWEN_API_KEY || '',
      baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },
  },

  // 支付配置
  payment: {
    wechat: {
      appId: process.env.WECHAT_PAY_APP_ID || '',
      mchId: process.env.WECHAT_PAY_MCH_ID || '',
      apiKey: process.env.WECHAT_PAY_API_KEY || '',
    },
    alipay: {
      appId: process.env.ALIPAY_APP_ID || '',
      privateKey: process.env.ALIPAY_PRIVATE_KEY || '',
      publicKey: process.env.ALIPAY_PUBLIC_KEY || '',
    },
    notifyUrl: process.env.PAYMENT_NOTIFY_URL || 'http://localhost:3000/api/payment/notify',
  },

  // 数据库
  dbPath: process.env.DB_PATH || './data/aihub.db',

  // 管理员
  admin: {
    phone: process.env.ADMIN_PHONE || '13800000000',
    password: process.env.ADMIN_PASSWORD || 'admin123456',
  },

  // 积分充值套餐
  creditPackages: [
    { id: 'pkg_9', price: 9.9, credits: 100, name: '体验档' },
    { id: 'pkg_29', price: 29.9, credits: 350, name: '入门档' },
    { id: 'pkg_99', price: 99, credits: 1200, name: '常用档' },
    { id: 'pkg_299', price: 299, credits: 4000, name: '重度档' },
  ],

  // 会员套餐
  memberPlans: [
    { id: 'member_month', price: 29, period: '月', credits: 300, discount: 0.9, name: '月度会员' },
    { id: 'member_quarter', price: 79, period: '季', credits: 900, discount: 0.9, name: '季度会员' },
    { id: 'member_year', price: 268, period: '年', credits: 3600, discount: 0.85, name: '年度会员' },
  ],

  // 模型定价配置 (积分/1k tokens)
  modelPricing: {
    // 入门档
    'deepseek-chat': { tier: 'basic', rate: 2, provider: 'deepseek', label: 'DeepSeek V3' },
    'qwen-turbo': { tier: 'basic', rate: 2, provider: 'qwen', label: '通义千问 Turbo' },
    // 进阶档
    'deepseek-coder': { tier: 'advanced', rate: 4, provider: 'deepseek', label: 'DeepSeek Coder' },
    'qwen-plus': { tier: 'advanced', rate: 4, provider: 'qwen', label: '通义千问 Plus' },
    'gpt-4o-mini': { tier: 'advanced', rate: 5, provider: 'openai', label: 'GPT-4o mini' },
    // 旗舰档
    'gpt-4o': { tier: 'flagship', rate: 12, provider: 'openai', label: 'GPT-4o' },
    'qwen-max': { tier: 'flagship', rate: 10, provider: 'qwen', label: '通义千问 Max' },
    // 推理档
    'deepseek-reasoner': { tier: 'reasoning', rate: 18, provider: 'deepseek', label: 'DeepSeek R1' },
    'o1-mini': { tier: 'reasoning', rate: 20, provider: 'openai', label: 'o1-mini' },
  },

  // 工具定价 (积分/次)
  toolPricing: {
    'image-standard': 8,    // 文生图标准
    'image-hd': 25,         // 文生图高清
    'video-short': 80,      // AI视频5秒内
    'document-parse': 15,   // 文档解析
    'web-search': 2,        // 联网搜索
  },
};
