'use strict';
// Project Beyond — Stage I: Free Tools & Integrations
// Audited from expanded_free_open_source_toolkit_100plus.txt
// Pure Node.js built-ins. Zero external dependencies.

// Categories:
// 1. FOSS: Free & Open Source (Local or Public API)
// 2. FREE_TIER: Free tier with documented quotas / restrictions
// 3. PAID_OR_KEY: Paid or API-key dependent (Subscription != API access)
// 4. UNSUPPORTED_OR_HEAVY: High RAM/VRAM (>8GB), heavy containerization, or Linux-only

const TOOLKIT_CATEGORIES = {
  FOSS: 'Free and Open Source (FOSS)',
  FREE_TIER: 'Free Tier (With Quotas/Limits)',
  PAID_OR_KEY: 'Paid or API-Key Dependent',
  UNSUPPORTED_OR_HEAVY: 'Unsupported / Heavy / Not Recommended for 8-12GB PC',
};

const AUDITED_TOOLKIT = [
  // Local AI & Models
  { id: 'ollama', name: 'Ollama', category: 'FOSS', type: 'local', status: 'integrated', terms: 'Free & Open Source. Runs locally. Requires local model pull.', ramNote: 'Small models (3B) recommended on 8-12 GB RAM.' },
  { id: 'llamacpp', name: 'llama.cpp', category: 'FOSS', type: 'local', status: 'compatible', terms: 'Free & Open Source C++ inference. Quantized GGUF models.', ramNote: 'Low overhead, highly efficient.' },
  { id: 'lmstudio', name: 'LM Studio', category: 'FOSS', type: 'local', status: 'available', terms: 'Free desktop application for local models.', ramNote: 'Requires 4-8 GB RAM depending on model.' },
  { id: 'jan', name: 'Jan', category: 'FOSS', type: 'local', status: 'available', terms: 'Free/open-source desktop AI assistant.', ramNote: 'Can be heavier than minimal CLI.' },
  { id: 'openwebui', name: 'Open WebUI', category: 'FOSS', type: 'local', status: 'available', terms: 'Self-hosted web UI for Ollama.', ramNote: 'Runs in browser; moderate memory.' },
  { id: 'hf_transformers', name: 'Hugging Face Transformers', category: 'FOSS', type: 'local', status: 'available', terms: 'Python ML library. Models require hardware.', ramNote: 'Heavy for 8 GB RAM if running large models in Python.' },

  // Cloud AI Providers & Free Tiers
  { id: 'gemini', name: 'Google Gemini API', category: 'FREE_TIER', type: 'cloud', status: 'integrated', terms: 'Genuine Free Tier: 15 RPM, 1,500 RPD for Gemini Flash. No credit card required.', ramNote: '0 MB local RAM (Cloud API).' },
  { id: 'groq', name: 'GroqCloud', category: 'FREE_TIER', type: 'cloud', status: 'integrated', terms: 'Genuine Free Tier: 30 RPM, 14,400 RPD (Llama 3.1 8B). Fast LPU inference.', ramNote: '0 MB local RAM (Cloud API).' },
  { id: 'openrouter', name: 'OpenRouter Free Models', category: 'FREE_TIER', type: 'cloud', status: 'integrated', terms: 'Access to curated :free models with community rate limits.', ramNote: '0 MB local RAM (Cloud API).' },
  { id: 'hf_hub', name: 'Hugging Face Hub API', category: 'FREE_TIER', type: 'cloud', status: 'integrated', terms: 'Public model and dataset discovery REST API. Zero authentication required.', ramNote: '0 MB local RAM (Cloud API).' },
  { id: 'wikipedia', name: 'Wikipedia Public REST API', category: 'FOSS', type: 'cloud', status: 'integrated', terms: '100% Free Public Encyclopedia API. Real facts, zero keys.', ramNote: '0 MB local RAM (Cloud API).' },

  // Paid / Key Dependent Services (Subscription != API)
  { id: 'openai_api', name: 'OpenAI API (ChatGPT/Codex)', category: 'PAID_OR_KEY', type: 'cloud', status: 'unconfigured', terms: 'Pay-as-you-go API. ChatGPT Plus ($20/mo) DOES NOT grant API access.', ramNote: 'Paid API tokens required.' },
  { id: 'anthropic_api', name: 'Anthropic Claude API', category: 'PAID_OR_KEY', type: 'cloud', status: 'unconfigured', terms: 'Paid pay-as-you-go API. Claude Pro subscription does NOT include API credits.', ramNote: 'Paid API tokens required.' },
  { id: 'deepseek_api', name: 'DeepSeek API', category: 'PAID_OR_KEY', type: 'cloud', status: 'unconfigured', terms: 'Low cost per token, but requires positive paid account balance. Web free chat != API.', ramNote: 'Paid credits required.' },

  // Coding & Developer Tools
  { id: 'sqlite', name: 'SQLite', category: 'FOSS', type: 'local', status: 'integrated', terms: 'Public domain embedded database. Zero network, zero configuration.', ramNote: 'Negligible RAM (<5 MB).' },
  { id: 'git', name: 'Git', category: 'FOSS', type: 'local', status: 'integrated', terms: 'Distributed version control system.', ramNote: 'Lightweight.' },
  { id: 'vscodium', name: 'VSCodium', category: 'FOSS', type: 'local', status: 'recommended', terms: 'Free/libre open-source binary of VS Code without telemetry.', ramNote: 'Moderate (200-400 MB RAM).' },
  { id: 'python', name: 'Python', category: 'FOSS', type: 'local', status: 'recommended', terms: 'General-purpose programming language.', ramNote: 'Lightweight core.' },

  // Design, Diagramming & Media
  { id: 'mermaid', name: 'Mermaid.js / Diagrams', category: 'FOSS', type: 'cloud', status: 'integrated', terms: 'Client-side diagram and flowchart rendering engine.', ramNote: 'Rendered in browser SVG.' },
  { id: 'blender', name: 'Blender', category: 'FOSS', type: 'local', status: 'external', terms: '3D modeling, animation, rendering, and VFX.', ramNote: 'Can be heavy; use Eevee and simple scenes.' },
  { id: 'freecad', name: 'FreeCAD', category: 'FOSS', type: 'local', status: 'external', terms: 'Parametric CAD for mechanical engineering.', ramNote: 'Moderate RAM.' },
  { id: 'inkscape', name: 'Inkscape', category: 'FOSS', type: 'local', status: 'external', terms: 'Vector graphics and SVG design.', ramNote: 'Moderate RAM.' },
  { id: 'gimp', name: 'GIMP', category: 'FOSS', type: 'local', status: 'external', terms: 'Raster image editor.', ramNote: 'Moderate RAM.' },
  { id: 'audacity', name: 'Audacity', category: 'FOSS', type: 'local', status: 'external', terms: 'Multi-track audio recording and editing.', ramNote: 'Lightweight.' },
  { id: 'ffmpeg', name: 'FFmpeg', category: 'FOSS', type: 'local', status: 'external', terms: 'Command-line audio and video processing framework.', ramNote: 'CPU-intensive during transcoding.' },

  // Robotics & Simulation
  { id: 'webots', name: 'Webots', category: 'FOSS', type: 'local', status: 'external', terms: 'Physics-based open-source robot simulator.', ramNote: 'Requires GPU/RAM; run isolated.' },
  { id: 'kicad', name: 'KiCad', category: 'FOSS', type: 'local', status: 'external', terms: 'Schematic capture and PCB layout design.', ramNote: 'Moderate RAM.' },

  // Unsupported or Heavy on 8-12 GB Windows PCs
  { id: 'comfyui', name: 'ComfyUI / Stable Diffusion', category: 'UNSUPPORTED_OR_HEAVY', type: 'local', status: 'rejected', terms: 'Local diffusion models require 6-12 GB dedicated VRAM and 15-40 GB disk.', ramNote: 'Risk of system freezing on 8-12 GB RAM.' },
  { id: 'forge', name: 'SD WebUI Forge / Fooocus', category: 'UNSUPPORTED_OR_HEAVY', type: 'local', status: 'rejected', terms: 'Heavy local image generation UI. Requires compatible high-end GPU.', ramNote: 'Not suitable for low-RAM baseline.' },
  { id: 'dify_selfhosted', name: 'Dify / Activepieces (Docker)', category: 'UNSUPPORTED_OR_HEAVY', type: 'local', status: 'rejected', terms: 'Multi-container Docker orchestration. Consumes 4-8 GB RAM just idle.', ramNote: 'Heavy container footprint.' },
  { id: 'ros2', name: 'ROS 2 / Gazebo on Windows', category: 'UNSUPPORTED_OR_HEAVY', type: 'local', status: 'rejected', terms: 'Linux-native robotics middleware. Fragile and complex build on Windows.', ramNote: 'High setup friction and disk usage (>20 GB).' },
];

// Live Hugging Face Hub Model Discovery API
// Official, public, 100% free, zero authentication required
async function searchHuggingFaceModels(query, limit = 5, timeoutMs = 8000) {
  const cleanQ = (query || '').trim();
  if (!cleanQ) return { ok: false, error: 'Query is empty', models: [] };

  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(cleanQ)}&limit=${Math.min(limit, 10)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ProjectBeyond/1.0 (free-toolkit-discovery)' },
      signal: ac.signal,
    });
    clearTimeout(to);

    if (!res.ok) {
      return { ok: false, error: `Hugging Face API returned HTTP ${res.status}`, models: [] };
    }

    const data = await res.json();
    const models = Array.isArray(data) ? data.map(m => ({
      id: m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      pipeline_tag: m.pipeline_tag || 'unknown',
      url: `https://huggingface.co/${m.id}`,
    })) : [];

    return {
      ok: true,
      query: cleanQ,
      count: models.length,
      models,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Hugging Face request timed out' : (err.message || 'Network error'),
      models: [],
    };
  }
}

// Live Hugging Face Hub Dataset Discovery API
async function searchHuggingFaceDatasets(query, limit = 5, timeoutMs = 8000) {
  const cleanQ = (query || '').trim();
  if (!cleanQ) return { ok: false, error: 'Query is empty', datasets: [] };

  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const url = `https://huggingface.co/api/datasets?search=${encodeURIComponent(cleanQ)}&limit=${Math.min(limit, 10)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ProjectBeyond/1.0 (free-toolkit-discovery)' },
      signal: ac.signal,
    });
    clearTimeout(to);

    if (!res.ok) {
      return { ok: false, error: `Hugging Face API returned HTTP ${res.status}`, datasets: [] };
    }

    const data = await res.json();
    const datasets = Array.isArray(data) ? data.map(d => ({
      id: d.id,
      downloads: d.downloads || 0,
      likes: d.likes || 0,
      url: `https://huggingface.co/datasets/${d.id}`,
    })) : [];

    return {
      ok: true,
      query: cleanQ,
      count: datasets.length,
      datasets,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Hugging Face request timed out' : (err.message || 'Network error'),
      datasets: [],
    };
  }
}

module.exports = {
  TOOLKIT_CATEGORIES,
  AUDITED_TOOLKIT,
  searchHuggingFaceModels,
  searchHuggingFaceDatasets,
};
