'use strict';
// Project Beyond — Modular Provider System
// Zero external dependencies. Uses Node.js native fetch and AbortController.
const fs = require('node:fs');
const path = require('node:path');

// Safe, zero-dependency .env loader
function loadEnv(filePath) {
  const p = filePath || path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return {};
  try {
    const content = fs.readFileSync(p, 'utf8');
    const lines = content.split(/\r?\n/);
    const loaded = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) {
        process.env[k] = v;
      }
      loaded[k] = true;
    }
    return loaded;
  } catch {
    return {};
  }
}

// Ensure .env is read once at module load
loadEnv();

function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const t = key.trim();
  if (t.length <= 8) return '****';
  return t.slice(0, 3) + '...' + t.slice(-4);
}

// Registry of supported providers with verified free-tier details
let geminiHealthCache = { timestamp: 0, result: null };
let ollamaHealthCache = { timestamp: 0, result: null };

const PROVIDERS = {
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    type: 'local',
    envVar: 'OLLAMA_HOST',
    defaultEndpoint: 'http://127.0.0.1:11434',
    terms: '100% Free & Unlimited. Runs completely locally on your hardware. Zero cloud tokens or API keys.',
    checkHealth: async (config = {}) => {
      const host = config.host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      const timeoutMs = config.timeoutMs || 2500;
      if (!config.forceRefresh && !config.host && ollamaHealthCache.result && (Date.now() - ollamaHealthCache.timestamp < 10000)) {
        return ollamaHealthCache.result;
      }
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch(`${host}/api/tags`, { signal: ac.signal });
        clearTimeout(to);
        if (!r.ok) {
          const res = { ok: false, connected: false, configured: true, status: 'error', error: `Ollama returned HTTP ${r.status}`, models: [], host };
          ollamaHealthCache = { timestamp: Date.now(), result: res };
          return res;
        }
        const data = await r.json().catch(() => ({}));
        const models = Array.isArray(data.models) ? data.models.map(m => m.name || m.model) : [];
        const res = {
          ok: true,
          connected: true,
          configured: true,
          status: models.length > 0 ? 'connected' : 'no_models',
          host,
          models,
          hasModels: models.length > 0,
          hasQwen: models.some(m => m.toLowerCase().includes('qwen2.5-coder')),
        };
        ollamaHealthCache = { timestamp: Date.now(), result: res };
        return res;
      } catch (err) {
        const isRefused = (err.cause && err.cause.code === 'ECONNREFUSED') || err.code === 'ECONNREFUSED';
        const res = {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          host,
          error: isRefused ? `Ollama daemon is not running at ${host}` : (err.message || 'Connection failed'),
          models: [],
          hasModels: false,
          hasQwen: false,
        };
        ollamaHealthCache = { timestamp: Date.now(), result: res };
        return res;
      }
    },
    generateContent: async ({ prompt, model = null, timeoutMs = 25000, host = null } = {}) => {
      const endpoint = host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      try {
        const health = await PROVIDERS.ollama.checkHealth({ host: endpoint, timeoutMs: 3000 });
        if (!health.connected || !health.models || health.models.length === 0) {
          return { ok: false, error: health.error || 'Ollama is offline or has no installed models.', status: 'unavailable' };
        }
        const targetModel = model || health.models[0];
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch(`${endpoint}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: targetModel, prompt, stream: false }),
          signal: ac.signal,
        });
        clearTimeout(to);
        if (!r.ok) {
          return { ok: false, error: `Ollama error HTTP ${r.status}`, status: 'error' };
        }
        const data = await r.json().catch(() => ({}));
        return { ok: true, text: data.response || '', model: targetModel };
      } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'Ollama request timed out' : err.message, status: 'error' };
      }
    },
  },

  gemini: {
    id: 'gemini',
    supportsVision: true, // Assignment 1.6: Gemini generateContent below accepts images as inlineData. This flag is only true because the code actually sends image bytes; never set it without that code.
    name: 'Google Gemini',
    type: 'cloud',
    envVar: 'GEMINI_API_KEY',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    terms: 'Genuine Free Tier: 15 Requests/Min, 1,500 Requests/Day for Gemini 1.5/2.0 Flash in Google AI Studio. No credit card required. Prompts may be logged for training on free tier.',
    checkHealth: async (config = {}) => {
      const key = (config.key !== null && config.key !== undefined) ? config.key : (process.env.GEMINI_API_KEY || '');
      if (!key || !key.trim()) {
        return {
          ok: false,
          connected: false,
          configured: false,
          status: 'missing_key',
          error: 'GEMINI_API_KEY is not set in environment or .env file.',
          models: [],
          maskedKey: null,
        };
      }
      if (!config.forceRefresh && config.key === undefined && geminiHealthCache.result && (Date.now() - geminiHealthCache.timestamp < 45000)) {
        return geminiHealthCache.result;
      }
      const timeoutMs = config.timeoutMs || 8000;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
          signal: ac.signal,
          headers: { 'Accept': 'application/json' },
        });
        clearTimeout(to);
        if (r.status === 400 || r.status === 401 || r.status === 403) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Authentication failed (HTTP ${r.status}): Invalid API key`, models: [], maskedKey: maskKey(key) };
        }
        if (r.status === 429) {
          return { ok: false, connected: false, configured: true, status: 'error', error: 'Gemini free-tier rate limit exceeded (HTTP 429)', models: [], maskedKey: maskKey(key) };
        }
        if (!r.ok) {
          const res = { ok: false, connected: false, configured: true, status: 'error', error: `Google API error: HTTP ${r.status}`, models: [], maskedKey: maskKey(key) };
          if (config.key === undefined) geminiHealthCache = { timestamp: Date.now(), result: res };
          return res;
        }
        const d = await r.json().catch(() => ({}));
        const models = Array.isArray(d.models)
          ? d.models.filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace('models/', '')).slice(0, 15)
          : [];
        const res = {
          ok: true,
          connected: true,
          configured: true,
          status: 'connected',
          models,
          maskedKey: maskKey(key),
        };
        if (config.key === undefined) geminiHealthCache = { timestamp: Date.now(), result: res };
        return res;
      } catch (err) {
        const res = {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          error: err.name === 'AbortError' ? 'Gemini connection timed out (3.5s)' : (err.message || 'Network error'),
          models: [],
          maskedKey: maskKey(key),
        };
        if (config.key === undefined) geminiHealthCache = { timestamp: Date.now(), result: res };
        return res;
      }
    },
    generateContent: async ({ prompt, model = 'gemini-flash-lite-latest', timeoutMs = 15000, key = null, maxOutputTokens = 4096, images = null, allowPaid = false } = {}) => {
      // Assignment 1.6 vision: if images are present, they must be actual
      // bytes (base64), not filenames or URLs. A paid or unknown model is
      // rejected before any provider call when allowPaid is not true.
      if (images && images.length > 0 && allowPaid !== true && !isVerifiedFreeGeminiModel(model)) {
        return { ok: false, error: `Gemini model "${model}" is not a verified free model for vision. Only gemini-flash-lite-latest is allowed when allowPaid is false.`, status: 'paid_model_blocked' };
      }
      const apiKey = (key !== null && key !== undefined) ? key : (process.env.GEMINI_API_KEY || '');
      if (!apiKey || !apiKey.trim()) {
        return {
          ok: false,
          error: 'GEMINI_API_KEY is not set in environment or .env file.',
          status: 'missing_key',
        };
      }

      const doFetch = async () => {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: (images && images.length > 0)
                ? [{ text: prompt }, ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 || img.data || '' } }))]
                : [{ text: prompt }] }],
              generationConfig: { maxOutputTokens, temperature: 0.2 },
            }),
            signal: ac.signal,
          });
          clearTimeout(to);
          return res;
        } catch (err) {
          clearTimeout(to);
          throw err;
        }
      };

      let res;
      try {
        res = await doFetch();
      } catch (err) {
        if (err.name === 'AbortError') {
          return { ok: false, error: `Gemini request timed out (${timeoutMs / 1000}s).`, status: 'timeout' };
        }
        try {
          res = await doFetch();
        } catch (retryErr) {
          return { ok: false, error: `Network error connecting to Gemini API: ${retryErr.message}`, status: 'network_error' };
        }
      }

      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return { ok: false, error: `Gemini authentication error (HTTP ${res.status}): Invalid API key.`, status: 'auth_error' };
      }
      if (res.status === 404) {
        return { ok: false, error: `Gemini model "${model}" not found (HTTP 404).`, status: 'model_not_found' };
      }
      if (res.status === 429) {
        return { ok: false, error: 'Gemini free-tier quota/rate limit exceeded (HTTP 429). Please wait before retrying.', status: 'quota_exceeded' };
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = (errBody.error && errBody.error.message) || `HTTP ${res.status}`;
        return { ok: false, error: `Gemini API error: ${msg}`, status: 'api_error' };
      }

      const data = await res.json().catch(() => ({}));
      const candidate = data.candidates && data.candidates[0];
      if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
        return { ok: false, error: 'Gemini returned an empty response or output was blocked by safety filters.', status: 'empty_response' };
      }

      const text = candidate.content.parts[0].text;
      return {
        ok: true,
        text,
        model,
        provider: 'gemini',
        finishReason: candidate.finishReason || 'STOP',
      };
    },
    testGemini: async (config = {}) => {
      // P1 Gemini paid-model bypass fix (Assignment 1.4): never call the
      // provider with a paid or unknown model when allowPaid is not an
      // explicit true. The model defaults to the verified free model, and
      // any other model is rejected before any provider call is made.
      const model = config.model || 'gemini-flash-lite-latest';
      if (config.allowPaid !== true && !isVerifiedFreeGeminiModel(model)) {
        return { ok: false, error: `Gemini model "${model}" is not a verified free model. Only gemini-flash-lite-latest is allowed when allowPaid is false.` };
      }
      return await PROVIDERS.gemini.generateContent({
        prompt: 'Return exactly: "Project Beyond Gemini Cloud Online."',
        model,
        timeoutMs: config.timeoutMs || 10000,
        key: config.key,
      });
    },
  },

  groq: {
    id: 'groq',
    name: 'GroqCloud',
    type: 'cloud',
    envVar: 'GROQ_API_KEY',
    defaultEndpoint: 'https://api.groq.com/openai/v1/models',
    terms: 'Genuine Free Tier: 30 Requests/Min, 14,400 Requests/Day (Llama 3.1 8B), 30 RPM / 1,000 RPD (Llama 3.3 70B & DeepSeek R1 distill). Fast LPU inference, no credit card required.',
    checkHealth: async (config = {}) => {
      const key = config.key || process.env.GROQ_API_KEY;
      if (!key) {
        return {
          ok: false,
          connected: false,
          configured: false,
          status: 'missing_key',
          error: 'GROQ_API_KEY is not set in environment or .env file.',
          models: [],
          maskedKey: null,
        };
      }
      const timeoutMs = config.timeoutMs || 8000;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch('https://api.groq.com/openai/v1/models', {
          signal: ac.signal,
          headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
        });
        clearTimeout(to);
        if (r.status === 401 || r.status === 403) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Authentication failed (HTTP ${r.status}): Invalid API key`, models: [], maskedKey: maskKey(key) };
        }
        if (r.status === 429) {
          return { ok: false, connected: false, configured: true, status: 'error', error: 'Groq free-tier rate limit exceeded (HTTP 429)', models: [], maskedKey: maskKey(key) };
        }
        if (!r.ok) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Groq API error: HTTP ${r.status}`, models: [], maskedKey: maskKey(key) };
        }
        const d = await r.json().catch(() => ({}));
        const models = Array.isArray(d.data) ? d.data.map(m => m.id).slice(0, 15) : [];
        return {
          ok: true,
          connected: true,
          configured: true,
          status: 'connected',
          models,
          maskedKey: maskKey(key),
        };
      } catch (err) {
        return {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          error: err.name === 'AbortError' ? 'Groq connection timed out (3.5s)' : (err.message || 'Network error'),
          models: [],
          maskedKey: maskKey(key),
        };
      }
    },
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'cloud',
    envVar: 'OPENROUTER_API_KEY',
    defaultEndpoint: 'https://openrouter.ai/api/v1/models',
    terms: 'Genuine Free Tier for :free models: 20 Requests/Min, 50 Requests/Day (upgraded to 1,000 RPD with $10 lifetime deposit). Access to DeepSeek-R1:free, Llama-3.3-70B:free, Qwen-2.5-Coder:free.',
    checkHealth: async (config = {}) => {
      const key = config.key || process.env.OPENROUTER_API_KEY;
      if (!key) {
        return {
          ok: false,
          connected: false,
          configured: false,
          status: 'missing_key',
          error: 'OPENROUTER_API_KEY is not set in environment or .env file.',
          models: [],
          maskedKey: null,
        };
      }
      const timeoutMs = config.timeoutMs || 8000;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch('https://openrouter.ai/api/v1/models', {
          signal: ac.signal,
          headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
        });
        clearTimeout(to);
        if (r.status === 401 || r.status === 403) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Authentication failed (HTTP ${r.status}): Invalid API key`, models: [], maskedKey: maskKey(key) };
        }
        if (!r.ok) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `OpenRouter API error: HTTP ${r.status}`, models: [], maskedKey: maskKey(key) };
        }
        const d = await r.json().catch(() => ({}));
        const models = Array.isArray(d.data)
          ? d.data.filter(m => m.id && m.id.endsWith(':free')).map(m => m.id).slice(0, 15)
          : [];
        return {
          ok: true,
          connected: true,
          configured: true,
          status: 'connected',
          models,
          maskedKey: maskKey(key),
        };
      } catch (err) {
        return {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          error: err.name === 'AbortError' ? 'OpenRouter connection timed out (3.5s)' : (err.message || 'Network error'),
          models: [],
          maskedKey: maskKey(key),
        };
      }
    },
    // P1 OpenRouter guard (Assignment 1.2): execution is NOT enabled.
    // This stub exists so a direct call fails with a clear error instead
    // of a TypeError, and so no paid model can be selected by accident.
    // Any future implementation MUST call assertFreeModel(model) and must
    // allow only verified ":free" models; unknown or unverified pricing
    // must be rejected. Do not replace this stub without that validation.
    generateContent: async () => {
      throw new Error('OpenRouter generation is not implemented. Model-level pricing must be validated (only verified ":free" models) before any OpenRouter execution is enabled.');
    },
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'cloud',
    envVar: 'DEEPSEEK_API_KEY',
    defaultEndpoint: 'https://api.deepseek.com/models',
    terms: 'Pay-As-You-Go API. Ultra-low cost ($0.14-$0.28 / 1M tokens), but requires prepaid balance. One-time promotional tokens are sometimes granted on registration (expires in 30 days). No permanent free tier.',
    checkHealth: async (config = {}) => {
      const key = config.key || process.env.DEEPSEEK_API_KEY;
      if (!key) {
        return {
          ok: false,
          connected: false,
          configured: false,
          status: 'missing_key',
          error: 'DEEPSEEK_API_KEY is not set in environment or .env file.',
          models: [],
          maskedKey: null,
        };
      }
      const timeoutMs = config.timeoutMs || 8000;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch('https://api.deepseek.com/models', {
          signal: ac.signal,
          headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
        });
        clearTimeout(to);
        if (r.status === 401 || r.status === 403) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Authentication failed (HTTP ${r.status}): Invalid API key`, models: [], maskedKey: maskKey(key) };
        }
        if (r.status === 402) {
          return { ok: false, connected: false, configured: true, status: 'error', error: 'DeepSeek account balance is zero or expired (HTTP 402 Payment Required)', models: [], maskedKey: maskKey(key) };
        }
        if (!r.ok) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `DeepSeek API error: HTTP ${r.status}`, models: [], maskedKey: maskKey(key) };
        }
        const d = await r.json().catch(() => ({}));
        const models = Array.isArray(d.data) ? d.data.map(m => m.id) : [];
        return {
          ok: true,
          connected: true,
          configured: true,
          status: 'connected',
          models,
          maskedKey: maskKey(key),
        };
      } catch (err) {
        return {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          error: err.name === 'AbortError' ? 'DeepSeek connection timed out (3.5s)' : (err.message || 'Network error'),
          models: [],
          maskedKey: maskKey(key),
        };
      }
    },
  },

  openai: {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    type: 'cloud',
    envVar: 'OPENAI_API_KEY',
    defaultEndpoint: 'https://api.openai.com/v1/models',
    terms: 'Pay-As-You-Go API. Requires prepaid credits. $5 trial credits are occasionally offered to new accounts (valid 3 months). No permanent free API tier. ChatGPT Plus web subscriptions do NOT include API access.',
    checkHealth: async (config = {}) => {
      const key = config.key || process.env.OPENAI_API_KEY;
      if (!key) {
        return {
          ok: false,
          connected: false,
          configured: false,
          status: 'missing_key',
          error: 'OPENAI_API_KEY is not set in environment or .env file.',
          models: [],
          maskedKey: null,
        };
      }
      const timeoutMs = config.timeoutMs || 8000;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch('https://api.openai.com/v1/models', {
          signal: ac.signal,
          headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
        });
        clearTimeout(to);
        if (r.status === 401 || r.status === 403) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Authentication failed (HTTP ${r.status}): Invalid API key`, models: [], maskedKey: maskKey(key) };
        }
        if (r.status === 429) {
          return { ok: false, connected: false, configured: true, status: 'error', error: 'OpenAI quota exceeded or rate limit reached (HTTP 429)', models: [], maskedKey: maskKey(key) };
        }
        if (!r.ok) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `OpenAI API error: HTTP ${r.status}`, models: [], maskedKey: maskKey(key) };
        }
        const d = await r.json().catch(() => ({}));
        const models = Array.isArray(d.data) ? d.data.map(m => m.id).filter(id => id.startsWith('gpt-')).slice(0, 10) : [];
        return {
          ok: true,
          connected: true,
          configured: true,
          status: 'connected',
          models,
          maskedKey: maskKey(key),
        };
      } catch (err) {
        return {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          error: err.name === 'AbortError' ? 'OpenAI connection timed out (3.5s)' : (err.message || 'Network error'),
          models: [],
          maskedKey: maskKey(key),
        };
      }
    },
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    type: 'cloud',
    envVar: 'ANTHROPIC_API_KEY',
    defaultEndpoint: 'https://api.anthropic.com/v1/models',
    terms: 'Pay-As-You-Go API. A one-time $5 trial grant is provided on new console accounts upon SMS verification. No permanent free tier. Claude Pro web chat subscriptions do NOT provide developer API access.',
    checkHealth: async (config = {}) => {
      const key = config.key || process.env.ANTHROPIC_API_KEY;
      if (!key) {
        return {
          ok: false,
          connected: false,
          configured: false,
          status: 'missing_key',
          error: 'ANTHROPIC_API_KEY is not set in environment or .env file.',
          models: [],
          maskedKey: null,
        };
      }
      const timeoutMs = config.timeoutMs || 8000;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch('https://api.anthropic.com/v1/models', {
          signal: ac.signal,
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Accept': 'application/json',
          },
        });
        clearTimeout(to);
        if (r.status === 401 || r.status === 403) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Authentication failed (HTTP ${r.status}): Invalid API key`, models: [], maskedKey: maskKey(key) };
        }
        if (r.status === 429) {
          return { ok: false, connected: false, configured: true, status: 'error', error: 'Anthropic rate limit or credit quota exceeded (HTTP 429)', models: [], maskedKey: maskKey(key) };
        }
        if (!r.ok) {
          return { ok: false, connected: false, configured: true, status: 'error', error: `Anthropic API error: HTTP ${r.status}`, models: [], maskedKey: maskKey(key) };
        }
        const d = await r.json().catch(() => ({}));
        const models = Array.isArray(d.data) ? d.data.map(m => m.id) : [];
        return {
          ok: true,
          connected: true,
          configured: true,
          status: 'connected',
          models,
          maskedKey: maskKey(key),
        };
      } catch (err) {
        return {
          ok: false,
          connected: false,
          configured: true,
          status: 'error',
          error: err.name === 'AbortError' ? 'Anthropic connection timed out (3.5s)' : (err.message || 'Network error'),
          models: [],
          maskedKey: maskKey(key),
        };
      }
    },
  },
};

// Return metadata for all registered providers
function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    envVar: p.envVar,
    terms: p.terms,
  }));
}

// Return sanitized status for all registered providers
async function getAllProviderStatuses() {
  const list = Object.values(PROVIDERS);
  const results = [];
  for (const p of list) {
    const health = await p.checkHealth();
    results.push({
      id: p.id,
      name: p.name,
      type: p.type,
      envVar: p.envVar,
      terms: p.terms,
      configured: health.configured,
      connected: health.connected,
      status: health.status,
      error: health.error || null,
      models: health.models || [],
      maskedKey: health.maskedKey || null,
      host: health.host || null,
    });
  }
  return results;
}

// P0 cost control (Assignment 1): server-side allowPaid enforcement.
// Paid = providers whose own terms in this file say Pay-As-You-Go with no
// permanent free tier: DeepSeek, OpenAI, Anthropic. Every other id, including
// unknown ids, is treated as paid (fail closed) — a provider must be
// explicitly listed as free before it can be used when allowPaid is false.
const PAID_PROVIDER_IDS = new Set(['deepseek', 'openai', 'anthropic']);
const FREE_PROVIDER_IDS = new Set(['ollama', 'gemini', 'groq', 'openrouter']);
function isPaidProvider(providerId) {
  return !FREE_PROVIDER_IDS.has(providerId);
}
function isFreeProvider(providerId) {
  return FREE_PROVIDER_IDS.has(providerId);
}
function assertAllowPaid(providerId, allowPaid) {
  // allowPaid must be an explicit true to allow a paid provider. Any other
  // value (false, undefined, null, non-boolean) fails closed.
  if (allowPaid === true) return;
  if (isPaidProvider(providerId)) {
    const err = new Error(`Paid provider "${providerId}" is blocked because allowPaid is false.`);
    err.status = 403;
    throw err;
  }
}

// P1 Gemini free-model allow-list (Assignment 1.4): the only Gemini model
// used anywhere in this codebase is gemini-flash-lite-latest, the default
// in generateContent below. No other Gemini model has verified free pricing
// in this codebase, so every other model is treated as paid/unknown and
// rejected when allowPaid is not an explicit true. Client-supplied model
// names are never trusted: the server route and testGemini both check here.
const FREE_GEMINI_MODELS = ['gemini-flash-lite-latest'];
function isVerifiedFreeGeminiModel(modelId) {
  return typeof modelId === 'string' && FREE_GEMINI_MODELS.includes(modelId);
}
function assertFreeGeminiModel(modelId, allowPaid) {
  if (allowPaid === true) return;
  if (!isVerifiedFreeGeminiModel(modelId)) {
    const err = new Error(`Gemini model "${modelId}" is not a verified free model. Only ${FREE_GEMINI_MODELS.join(', ')} ${FREE_GEMINI_MODELS.length === 1 ? 'is' : 'are'} allowed when allowPaid is false.`);
    err.status = 403;
    throw err;
  }
}

// P1 OpenRouter model pricing (Assignment 1.2): OpenRouter execution is
// NOT enabled in this codebase. Any future implementation must validate
// model-level pricing before calling the API, and must allow only models
// whose pricing is verified free. A model id ending in ":free" is the only
// form accepted here as verified-free; every other form, including unknown,
// unverified or missing model ids, is rejected (fail closed).
function isVerifiedFreeModel(modelId) {
  return typeof modelId === 'string' && modelId.length > 5 && modelId.endsWith(':free');
}
function assertFreeModel(modelId) {
  if (!isVerifiedFreeModel(modelId)) {
    const err = new Error(`OpenRouter model "${modelId}" is not a verified free model. Only models ending in ":free" are allowed.`);
    err.status = 403;
    throw err;
  }
}

module.exports = {
  PROVIDERS,
  loadEnv,
  maskKey,
  listProviders,
  getAllProviderStatuses,
  PAID_PROVIDER_IDS,
  FREE_PROVIDER_IDS,
  isPaidProvider,
  isFreeProvider,
  assertAllowPaid,
  isVerifiedFreeModel,
  assertFreeModel,
  FREE_GEMINI_MODELS,
  isVerifiedFreeGeminiModel,
  assertFreeGeminiModel,
};
