'use strict';
// allowPaid:false and provider fallback restrictions — baseline repository code.
// No real provider is called. The paid provider here is a mock labelled as paid;
// its generateContent is never expected to be reached through the repository
// task path, which is itself part of the finding.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mockProvider } = require('./helpers');
const { findFallbackProvider } = require('../orchestrator');
const BASELINE = path.join(__dirname, '..');

describe('allowPaid and fallback', () => {
  it('FIXED-BEHAVIOUR (updated from CURRENT-BEHAVIOUR after P0 fix): fallback does NOT return a pay-as-you-go provider when allowPaid is false', async () => {
    const providers = {
      gemini: mockProvider('gemini', { connected: false, models: [] }),
      groq: mockProvider('groq', { connected: false, models: [] }),
      openrouter: mockProvider('openrouter', { connected: false, models: [] }),
      deepseek: mockProvider('deepseek', { connected: true, models: ['deepseek-chat'] }),
      ollama: mockProvider('ollama', { connected: false, models: [] }),
    };
    const fallback = await findFallbackProvider('gemini', providers, () => {}, { allowPaid: false });
    assert.ok(!fallback || fallback.id !== 'deepseek', 'free-first fallback must not select a pay-as-you-go provider');
  });

  it('FAIL-EXPECTED (desired behaviour): fallback must not return a paid provider when free-first is intended', async () => {
    const providers = {
      gemini: mockProvider('gemini', { connected: false, models: [] }),
      groq: mockProvider('groq', { connected: false, models: [] }),
      openrouter: mockProvider('openrouter', { connected: false, models: [] }),
      deepseek: mockProvider('deepseek', { connected: true, models: ['deepseek-chat'] }),
      ollama: mockProvider('ollama', { connected: false, models: [] }),
    };
    // The repository function has no allowPaid argument at all, so there is no
    // way for a caller to request a free-only fallback. This call proves that.
    const fnText = findFallbackProvider.toString();
    assert.ok(fnText.includes('allowPaid'), 'fallback function must have an allowPaid concept after the P0 fix (updated assertion; desired assertion below is unchanged)');
    const fallback = await findFallbackProvider('gemini', providers, () => {});
    assert.ok(!fallback || fallback.id !== 'deepseek', 'free-first fallback must not select a pay-as-you-go provider');
  });

  it('FAIL-EXPECTED (desired behaviour): allowPaid must appear in the execution path', () => {
    const orch = fs.readFileSync(path.join(BASELINE, 'orchestrator.js'), 'utf8');
    const server = fs.readFileSync(path.join(BASELINE, 'server.js'), 'utf8');
    const providersSrc = fs.readFileSync(path.join(BASELINE, 'providers.js'), 'utf8');
    const combined = orch + server + providersSrc;
    assert.ok(combined.includes('allowPaid'), 'allowPaid must be enforced in orchestrator, server or providers');
  });

  it('PASS (partial mitigation, not a full guarantee): repository task execution only allows gemini and ollama', () => {
    const server = fs.readFileSync(path.join(BASELINE, 'server.js'), 'utf8');
    assert.ok(server.includes("providerId !== 'gemini' && providerId !== 'ollama'"));
    assert.ok(server.includes('Unsupported execution provider'));
  });
});
