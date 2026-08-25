#!/usr/bin/env node
// =============================================================================
// Sales Analytics Alert — runs Monday 8am PDT
// Checks fast-selling and stale items per machine, alerts via Telegram
// =============================================================================
const https = require('https');
const { execSync } = require('child_process');

const DASHBOARD_URL = 'vend.kandedash.com';
const API_KEY = 'kande2026';
const TELEGRAM_CHAT = '-4992441037';
const LOG_FILE = '/Users/kurtishon/clawd/logs/sales-analytics-alert.log';
const fs = require('fs');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function sendTelegram(msg) {
  try {
    execSync(`openclaw message send --channel telegram --target ${TELEGRAM_CHAT} --message ${JSON.stringify(msg)}`, { timeout: 15000 });
    log('Telegram sent');
  } catch (e) { log(`Telegram failed: ${e.message}`); }
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: DASHBOARD_URL, port: 443, path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve({ raw: b.substring(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  log('===== Sales analytics alert starting =====');
  try {
    // Get machines
    const machines = await apiGet('/api/office-machines');
    if (!Array.isArray(machines) || machines.length === 0) {
      log('No machines found');
      return;
    }
    log(`Checking ${machines.length} machines`);

    const allFast = [];
    const allStale = [];

    for (const m of machines) {
      try {
        const data = await apiGet(`/api/sales-analytics/weekly?machine=${encodeURIComponent(m.name)}&weeks=8`);
        if (data.fast_selling && data.fast_selling.length > 0) {
          data.fast_selling.forEach(item => {
            allFast.push({ machine: m.name, ...item });
          });
        }
        if (data.stale && data.stale.length > 0) {
          data.stale.forEach(item => {
            allStale.push({ machine: m.name, ...item });
          });
        }
      } catch (e) {
        log(`Error checking ${m.name}: ${e.message}`);
      }
    }

    let msg = '';

    if (allFast.length > 0) {
      msg += `🔥 *Fast-Selling Items*\n`;
      allFast.forEach(item => {
        msg += `• ${item.machine}: ${item.name} — ${item.avg_weekly_velocity}/wk (${item.pct_of_capacity}% of capacity)\n`;
      });
      msg += '\n';
    }

    if (allStale.length > 0) {
      msg += `🥶 *Stale Items*\n`;
      allStale.forEach(item => {
        msg += `• ${item.machine}: ${item.name} — ${item.consecutive_zero_weeks} weeks no sales\n`;
      });
    }

    if (msg) {
      log(`Alerting: ${allFast.length} fast, ${allStale.length} stale`);
      sendTelegram(msg.trim());
    } else {
      log('No issues found — silent');
    }
  } catch (e) {
    log(`Fatal error: ${e.message}`);
  }
})();
