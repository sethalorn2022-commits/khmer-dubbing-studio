// Vercel serverless function: proxies Microsoft Edge TTS (free, unofficial) so the browser can use it.
const WebSocket = require('ws'), crypto = require('crypto');
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4', VER = '1-130.0.2849.68';
const VOICES = ['km-KH-PisethNeural', 'km-KH-SreymomNeural'];
const gec = () => { let t = Math.floor(Date.now() / 1000) + 11644473600; t -= t % 300;
  return crypto.createHash('sha256').update(Math.round(t * 1e7) + TOKEN, 'ascii').digest('hex').toUpperCase(); };
const esc = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const ts = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

function synth(text, voice, rate, pitch) {
  return new Promise((ok, no) => {
    const id = crypto.randomUUID().replace(/-/g, '');
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${VER}&ConnectionId=${id}`;
    const ws = new WebSocket(url, { headers: { Pragma: 'no-cache', 'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0' } });
    const parts = [], timer = setTimeout(() => { ws.terminate(); no(new Error('Edge TTS timeout')); }, 20000);
    ws.on('open', () => {
      ws.send(`X-Timestamp:${ts()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts()}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='km-KH'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc(text)}</prosody></voice></speak>`);
    });
    ws.on('message', (d, bin) => {
      if (bin) { const n = d.readUInt16BE(0); if (d.slice(2, 2 + n).toString().includes('Path:audio')) parts.push(d.slice(2 + n)); }
      else if (d.toString().includes('Path:turn.end')) { clearTimeout(timer); ws.close(); parts.length ? ok(Buffer.concat(parts)) : no(new Error('Edge TTS returned no audio')); }
    });
    ws.on('unexpected-response', (q, r) => { clearTimeout(timer); no(new Error('Edge TTS rejected the request (HTTP ' + r.statusCode + ')')); });
    ws.on('error', e => { clearTimeout(timer); no(e); });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
  const { text = '', voice = 'km-KH-SreymomNeural', rate = '+0%', pitch = '+0Hz' } = b;
  if (!VOICES.includes(voice) || !String(text).trim() || text.length > 1000 || !/^[+-]\d{1,3}%$/.test(rate) || !/^[+-]\d{1,3}Hz$/.test(pitch))
    return res.status(400).json({ error: 'Bad request: check text (max 1000 chars), voice, rate and pitch' });
  try { const buf = await synth(text, voice, rate, pitch); res.setHeader('Content-Type', 'audio/mpeg'); res.status(200).send(buf); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
};
