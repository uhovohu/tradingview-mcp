import { z } from 'zod';
import { jsonResult } from './tools/_format.js';

const registry = new Map(); // name -> { tool, group }

function callerGroup() {
  const lines = (new Error().stack || '').split('\n');
  for (const line of lines) {
    const m = line.match(/tools[\\/](\w+)\.js/);
    if (m && m[1] !== '_format') return m[1];
  }
  return 'other';
}

/** Wrap server.tool / server.registerTool so every registered tool is recorded with its group. */
export function installToolFilter(server) {
  for (const method of ['tool', 'registerTool']) {
    const orig = server[method]?.bind(server);
    if (!orig) continue;
    server[method] = (...args) => {
      const tool = orig(...args);
      const name = typeof args[0] === 'string' ? args[0] : null;
      if (name) registry.set(name, { tool, group: callerGroup() });
      return tool;
    };
  }
}

function parseList(v) {
  return (v || '').split(',').map(s => s.trim()).filter(Boolean);
}

function snapshot() {
  const out = {};
  for (const [name, { tool, group }] of registry) {
    out[group] ??= { enabled: [], disabled: [] };
    out[group][tool.enabled ? 'enabled' : 'disabled'].push(name);
  }
  return out;
}

/** Apply the TV_TOOLS whitelist and register the always-on tv_tools control tool. */
export function applyToolFilter(server) {
  const whitelist = parseList(process.env.TV_TOOLS);
  if (whitelist.length) {
    const allow = new Set(whitelist);
    for (const [name, { tool }] of registry) if (!allow.has(name)) tool.disable();
    const unknown = whitelist.filter(n => !registry.has(n));
    if (unknown.length) process.stderr.write(`tradingview-mcp: TV_TOOLS lists unknown tools: ${unknown.join(', ')}\n`);
  }

  let description = 'Manage which TradingView tools are enabled. Some tools are disabled by default to save context. Call action=list to see enabled/disabled tools per group, and action=enable (with tools and/or groups) to turn on a disabled tool when the user\'s request needs it. Use action=disable to turn tools off again.';
  if (whitelist.length) {
    const disabled = Object.entries(snapshot())
      .filter(([, g]) => g.disabled.length)
      .map(([group, g]) => `${group}: ${g.disabled.join(', ')}`);
    if (disabled.length) description += ` Disabled by default — ${disabled.join('; ')}`;
  }
  const groupNames = [...new Set([...registry.values()].map(e => e.group))].filter(g => g !== 'other');

  server.tool(
    'tv_tools',
    description,
    {
      action: z.enum(['list', 'enable', 'disable']).describe('list | enable | disable'),
      tools: z.array(z.string()).optional().describe('Tool names to enable/disable'),
      groups: z.array(z.string()).optional().describe(`Groups to enable/disable: ${groupNames.join(', ')}`),
    },
    async ({ action, tools, groups }) => {
      try {
        if (action === 'list') return jsonResult(snapshot());
        const targets = new Set();
        const unknown = [];
        for (const n of tools || []) registry.has(n) ? targets.add(n) : unknown.push(n);
        for (const g of groups || []) {
          let found = false;
          for (const [name, e] of registry) if (e.group === g) { targets.add(name); found = true; }
          if (!found) unknown.push(`group:${g}`);
        }
        targets.delete('tv_tools');
        const changed = [];
        for (const name of targets) {
          const { tool } = registry.get(name);
          if (action === 'enable' && !tool.enabled) { tool.enable(); changed.push(name); }
          else if (action === 'disable' && tool.enabled) { tool.disable(); changed.push(name); }
        }
        return jsonResult({ success: true, action, changed, unknown });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
