// Vercel serverless function for Khmer Dubbing Studio TTS.
// Default: Microsoft Edge Read Aloud websocket (free, unofficial, can be blocked).
// Optional fallback: set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in Vercel.
const WebSocket = require('ws');
const crypto = require('crypto');
const https = require('https');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const VOICES = new Set(['km-KH-PisethNeural', 'km-KH-SreymomNeural']);
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const WIN_EPOCH = 11644473600;

let clockSkewSeconds = 0;

function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000 + clockSkewSeconds) + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks = Math.round(ticks * 10_000_000);
  return crypto.createHash('sha256').update(`${ticks}${TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function updateClockSkew(dateHeader) {
  if (!dateHeader) return;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return;
  clockSkewSeconds += serverMs / 1000 - Date.now() / 1000;
}

function muid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function edgeHeaders() {
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'Sec-WebSocket-Version': '13',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${muid()};`,
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  };
}

function jsDate() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function ssml({ text, voice, rate, pitch }) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='km-KH'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`;
}

function edgeRequestUrl(connectionId) {
  return `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
}

function synthEdge(payload) {
  return new Promise((resolve, reject) => {
    const connectionId = crypto.randomUUID().replace(/-/g, '');
    const ws = new WebSocket(edgeRequestUrl(connectionId), {
      headers: edgeHeaders(),
      handshakeTimeout: 10000,
      perMessageDeflate: true,
    });

    const chunks = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Edge TTS timeout'));
    }, 30000);

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${jsDate()}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
      );
      ws.send(
        `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${jsDate()}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          ssml(payload),
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (data.length < 2) return;
        const headerLength = data.readUInt16BE(0);
        const header = data.slice(2, 2 + headerLength).toString('utf8');
        if (header.includes('Path:audio')) chunks.push(data.slice(2 + headerLength));
        return;
      }
      if (data.toString('utf8').includes('Path:turn.end')) {
        clearTimeout(timer);
        ws.close();
        chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error('Edge TTS returned no audio'));
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      updateClockSkew(res.headers && res.headers.date);
      reject(new Error(`Edge TTS rejected the request (HTTP ${res.statusCode})`));
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function synthAzure(payload) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return Promise.reject(new Error('Azure Speech fallback is not configured'));

  return new Promise((resolve, reject) => {
    const body = ssml(payload);
    const req = https.request(
      {
        method: 'POST',
        hostname: `${region}.tts.speech.microsoft.com`,
        path: '/cognitiveservices/v1',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
          'User-Agent': 'Khmer-Dubbing-Studio',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const out = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(out);
          else reject(new Error(`Azure Speech rejected the request (HTTP ${res.statusCode}): ${out.toString('utf8').slice(0, 200)}`));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Azure Speech timeout')));
    req.end(body);
  });
}

async function synth(payload) {
  try {
    return await synthEdge(payload);
  } catch (error) {
    const edgeMessage = String(error.message || error);
    if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) {
      try {
        return await synthAzure(payload);
      } catch (fallbackError) {
        throw new Error(`${edgeMessage}; fallback also failed: ${fallbackError.message || fallbackError}`);
      }
    }
    throw new Error(`${edgeMessage}. Edge TTS is unofficial and may block Vercel/cloud servers. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION for a stable fallback.`);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_error) { body = {}; }
  }
  body = body || {};

  const payload = {
    text: String(body.text || '').trim(),
    voice: body.voice || 'km-KH-SreymomNeural',
    rate: body.rate || '+0%',
    pitch: body.pitch || '+0Hz',
  };

  if (
    !VOICES.has(payload.voice) ||
    !payload.text ||
    Buffer.byteLength(payload.text, 'utf8') > 4096 ||
    !/^[+-]\d{1,3}%$/.test(payload.rate) ||
    !/^[+-]\d{1,3}Hz$/.test(payload.pitch)
  ) {
    return res.status(400).json({ error: 'Bad request: check text (max 4096 UTF-8 bytes), voice, rate and pitch' });
  }

  try {
    const audio = await synth(payload);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
};
