'use strict';
// Project Beyond — Genuine Research Gathering Engine
// Uses official public Wikipedia API for real, non-fabricated facts. Zero external dependencies.

async function fetchSources(topic, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const cleanTopic = (topic || '').trim();
  if (!cleanTopic) return { ok: false, sources: [], query: cleanTopic };

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanTopic)}&limit=3&namespace=0&format=json`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'ProjectBeyond/1.0 (ai-research-agent)' },
      signal: ac.signal
    });
    clearTimeout(to);

    if (!res.ok) {
      return { ok: false, sources: [], error: `Search API returned HTTP ${res.status}`, query: cleanTopic };
    }

    const data = await res.json();
    const titles = Array.isArray(data[1]) ? data[1] : [];
    const urls = Array.isArray(data[3]) ? data[3] : [];

    const sources = [];
    for (let i = 0; i < Math.min(titles.length, 3); i++) {
      const title = titles[i];
      const url = urls[i];
      if (!title) continue;

      try {
        const sumAc = new AbortController();
        const sumTo = setTimeout(() => sumAc.abort(), 4000);
        const sumRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
          headers: { 'User-Agent': 'ProjectBeyond/1.0 (ai-research-agent)' },
          signal: sumAc.signal
        });
        clearTimeout(sumTo);
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          sources.push({
            title: sumData.title || title,
            extract: sumData.extract || 'No extract available.',
            description: sumData.description || '',
            url: (sumData.content_urls && sumData.content_urls.desktop && sumData.content_urls.desktop.page) || url || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
          });
          continue;
        }
      } catch {
        // Fallback to basic entry if individual summary times out
      }

      sources.push({
        title,
        extract: '',
        url: url || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
      });
    }

    return {
      ok: true,
      sources,
      query: cleanTopic
    };
  } catch (err) {
    return {
      ok: false,
      sources: [],
      error: err.name === 'AbortError' ? 'Search request timed out' : (err.message || 'Network error'),
      query: cleanTopic
    };
  }
}

module.exports = {
  fetchSources
};
