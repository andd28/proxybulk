// index.js — версия с мгновенным переключением при 429 или обрыве TLS
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxiesPath = path.join(__dirname, 'proxies.txt');

let proxies = [];
try {
  proxies = fs.readFileSync(proxiesPath, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  console.log(`Загружено прокси из proxies.txt: ${proxies.length}`);
} catch (e) {
  console.error('Ошибка чтения proxies.txt:', e && e.message);
}

if (proxies.length === 0) {
  console.warn('Внимание! Список прокси пуст.');
}

let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 20;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function switchToNextProxy() {
  if (proxies.length === 0) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
  console.log(`Сменили прокси на #${currentProxyIndex}: ${proxies[currentProxyIndex]}`);
}

function createAgent(proxy) {
  return new SocksProxyAgent(`socks4://${proxy}`);
}

async function fetchWithProxy(url, attemptsLeft = proxies.length) {
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст или не загружен!');
  }
  if (attemptsLeft <= 0) {
    throw new Error('Все прокси не сработали (исчерпаны попытки).');
  }

  if (requestCounter >= requestsPerProxy) {
    switchToNextProxy();
  }

  const proxy = proxies[currentProxyIndex];
  console.log(`Используем прокси #${currentProxyIndex}: ${proxy} (${requestCounter + 1}/${requestsPerProxy})`);

  const agent = createAgent(proxy);

  try {
    const res = await fetch(url, { agent, timeout: 8000 });

    if (res.status === 429) {
      console.warn(`HTTP 429 от прокси ${proxy} — переключаемся мгновенно`);
      switchToNextProxy();
      return fetchWithProxy(url, attemptsLeft - 1);
    }

    if (!res.ok) {
      throw new Error(`HTTP статус ${res.status}`);
    }

    const json = await res.json();
    if (!json || (typeof json === 'object' && Object.keys(json).length === 0)) {
      throw new Error('Пустой JSON от TinEye');
    }

    requestCounter++;
    return json;
  } catch (err) {
    const msg = err.message || '';
    if (
      msg.includes('Client network socket disconnected before secure') ||
      msg.includes('ECONNRESET')
    ) {
      console.warn(`Ошибка TLS/сокета через ${proxy} — переключаемся мгновенно`);
      switchToNextProxy();
      return fetchWithProxy(url, attemptsLeft - 1);
    }

    console.error(`Прокси ${proxy} не сработал: ${msg}. Попыток осталось: ${attemptsLeft - 1}`);
    switchToNextProxy();
    return fetchWithProxy(url, attemptsLeft - 1);
  }
}

// Vercel handler
module.exports = async (req, res) => {
  try {
    const base = `https://${req.headers.host || 'example.com'}`;
    const reqUrl = new URL(req.url, base);
    const page = reqUrl.searchParams.get('page') || '1';
    const imageUrl = reqUrl.searchParams.get('url');
    const tags = reqUrl.searchParams.get('tags');

    if (!imageUrl) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
      return;
    }

    let searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(imageUrl)}`;
    if (tags) {
      searchUrl += `&tags=${encodeURIComponent(tags)}`;
    }

    console.log('TinEye URL:', searchUrl);

    const tineyeJson = await fetchWithProxy(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(tineyeJson));
  } catch (err) {
    console.error('Handler error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
};

// Локальный тест
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.get('/tineye', module.exports);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server: http://localhost:${port}/tineye`));
}
