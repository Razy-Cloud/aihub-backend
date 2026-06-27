/**
 * 大模型服务 - 对接 DeepSeek / Qwen / OpenAI 兼容接口
 * 支持：流式输出、非流式、模拟模式（无Key时自动降级）
 */
const config = require('../config');

function getProviderConfig(model) {
  const modelMap = {
    'deepseek-chat': 'deepseek',
    'deepseek-coder': 'deepseek',
    'deepseek-reasoner': 'deepseek',
    'qwen-turbo': 'qwen',
    'qwen-plus': 'qwen',
    'qwen-max': 'qwen',
    'gpt-4o': 'openai',
    'gpt-4o-mini': 'openai',
    'o1-mini': 'openai',
  };
  const provider = modelMap[model] || 'deepseek';
  const providerConfig = config.llm[provider];
  return { provider, apiKey: providerConfig.apiKey, baseUrl: providerConfig.baseUrl };
}

function isApiKeyConfigured(model) {
  const { apiKey } = getProviderConfig(model);
  return !!(apiKey && apiKey.length > 10 && !apiKey.includes('your'));
}

async function chatCompletion(model, messages, options) {
  options = options || {};
  const { apiKey, baseUrl } = getProviderConfig(model);
  if (!isApiKeyConfigured(model)) {
    return mockCompletion(model, messages);
  }
  const body = {
    model: model,
    messages: messages,
    temperature: options.temperature != null ? options.temperature : 0.7,
    max_tokens: options.max_tokens || 4096,
  };
  const resp = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('LLM API ' + resp.status + ': ' + errText);
  }
  const data = await resp.json();
  return {
    content: data.choices[0].message.content,
    model: data.model,
    usage: data.usage,
    finish_reason: data.choices[0].finish_reason,
  };
}

async function* streamChatCompletion(model, messages, options) {
  options = options || {};
  const { apiKey, baseUrl } = getProviderConfig(model);
  if (!isApiKeyConfigured(model)) {
    yield* mockStreamCompletion(model, messages);
    return;
  }
  const body = {
    model: model,
    messages: messages,
    temperature: options.temperature != null ? options.temperature : 0.7,
    max_tokens: options.max_tokens || 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  const resp = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('LLM API ' + resp.status + ': ' + errText);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const lines = buffer.split('
');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') { yield { type: 'done' }; return; }
      try {
        const json = JSON.parse(dataStr);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && delta.content) yield { type: 'token', content: delta.content };
        if (json.usage) yield { type: 'usage', usage: json.usage };
      } catch (e) {}
    }
  }
  yield { type: 'done' };
}

function mockCompletion(model, messages) {
  const lastMsg = messages[messages.length - 1];
  const prompt = lastMsg ? lastMsg.content : '';
  const mockContent = '[模拟模式] 请到 server/.env 中配置真实的 API Key。您的提问：' + prompt.slice(0, 80) + (prompt.length > 80 ? '...' : '') + '

接入真实 API 后此处将显示模型真实回复。';
  return { content: mockContent, model: model, usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 }, finish_reason: 'stop' };
}

async function* mockStreamCompletion(model, messages) {
  const content = mockCompletion(model, messages).content;
  for (const ch of content) { yield { type: 'token', content: ch }; await new Promise(r => setTimeout(r, 12)); }
  yield { type: 'usage', usage: { prompt_tokens: 50, completion_tokens: content.length, total_tokens: 50 + content.length } };
  yield { type: 'done' };
}

module.exports = { chatCompletion, streamChatCompletion, isApiKeyConfigured, getProviderConfig };
