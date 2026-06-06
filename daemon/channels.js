// BagIdea AI Agents Office — external channel connectors (zero-dep).
// The office answers the outside world through the Director (main):
//   • Telegram — long-poll getUpdates (works behind any NAT, no public URL)
//   • Discord  — real gateway connection (hand-rolled WSS client)
//   • LINE     — Messaging API webhook (POST /channels/line/webhook — needs a
//                public HTTPS URL, e.g. a cloudflared tunnel; replies are
//                PUSHed so slow agent runs never outlive a reply token)
// Config lives in registry.json under reg.channels (edited in ⚙ CONNECT).

const https = require("https");
const tls = require("tls");
const crypto = require("crypto");

// ---- tiny https JSON request ------------------------------------------------
function jreq(method, host, path, headers, body, cb, timeoutMs) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = https.request({
    method, host, path,
    headers: {
      ...(headers || {}),
      ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
    },
  }, (res) => {
    let out = "";
    res.on("data", (c) => (out += c));
    res.on("end", () => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      cb(null, j, res.statusCode);
    });
  });
  req.setTimeout(timeoutMs || 65000, () => req.destroy(new Error("timeout")));
  req.on("error", (e) => cb(e));
  if (data) req.write(data);
  req.end();
}

// ---- minimal WebSocket CLIENT (for the Discord gateway) ---------------------
// Client frames must be masked; we speak text frames + ping/pong + close.
function wsConnect(host, path, hooks) {
  const key = crypto.randomBytes(16).toString("base64");
  let handshook = false;
  let buf = Buffer.alloc(0);
  let frag = null;  // continuation-frame accumulator
  const sock = tls.connect(443, host, { servername: host }, () => {
    sock.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`);
  });
  function sendRaw(payload, op) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let head;
    if (p.length < 126) head = Buffer.from([0x80 | op, 0x80 | p.length]);
    else if (p.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2);
    }
    const masked = Buffer.from(p);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    try { sock.write(Buffer.concat([head, mask, masked])); } catch {}
  }
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!handshook) {
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      handshook = true;
      buf = buf.slice(i + 4);
      hooks.onOpen && hooks.onOpen();
    }
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80);
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 1 || op === 0) {
        frag = frag ? Buffer.concat([frag, payload]) : payload;
        if (fin) { const msg = frag.toString("utf8"); frag = null; hooks.onMsg && hooks.onMsg(msg); }
      } else if (op === 9) sendRaw(payload, 10);   // ping → pong
      else if (op === 8) { try { sock.end(); } catch {} return; }
    }
  });
  sock.on("close", () => hooks.onClose && hooks.onClose());
  sock.on("error", () => {});
  return { send: (s) => sendRaw(s, 1), close: () => { try { sock.destroy(); } catch {} } };
}

// ---- connectors --------------------------------------------------------------
module.exports = function initChannels(ctx) {
  // ctx: getConfig() → reg.channels, onMessage(channel, from, text, reply), log(s)
  const state = { telegram: "off", discord: "off", line: "off" };
  let tgAlive = false;
  let dcSock = null, dcBeat = null, dcSeq = null, dcWant = false;

  const log = (s) => ctx.log && ctx.log("[chan] " + s);

  // ---- Telegram: long-poll — the friendliest possible integration.
  function startTelegram() {
    const cfg = (ctx.getConfig().telegram) || {};
    if (!cfg.enabled || !cfg.token) { state.telegram = "off"; return; }
    state.telegram = "connecting";
    tgAlive = true;
    let offset = 0;
    const poll = () => {
      if (!tgAlive) return;
      jreq("GET", "api.telegram.org",
        `/bot${cfg.token}/getUpdates?timeout=50&offset=${offset}`, null, null,
        (e, j) => {
          if (!tgAlive) return;
          if (e || !j) { state.telegram = "error"; return setTimeout(poll, 8000); }
          if (!j.ok) { state.telegram = "error: " + (j.description || "bad token"); return setTimeout(poll, 15000); }
          state.telegram = "on";
          for (const u of j.result || []) {
            offset = u.update_id + 1;
            const m = u.message;
            if (!m || !m.text) continue;
            // Optional allowlist: a chat id pins the office to YOUR chat.
            if (cfg.chat && String(m.chat.id) !== String(cfg.chat)) continue;
            const from = [m.from && m.from.first_name, m.from && m.from.last_name]
              .filter(Boolean).join(" ") || "telegram user";
            const chatId = m.chat.id;
            ctx.onMessage("telegram", from, m.text,
              (reply) => sendTelegram(cfg.token, chatId, reply));
          }
          setTimeout(poll, 400);
        });
    };
    poll();
    log("telegram poller started");
  }
  function sendTelegram(token, chatId, text) {
    const parts = chunk(String(text), 3900);
    const sendNext = (i) => {
      if (i >= parts.length) return;
      jreq("POST", "api.telegram.org", `/bot${token}/sendMessage`, null,
        { chat_id: chatId, text: parts[i] }, () => sendNext(i + 1));
    };
    sendNext(0);
  }

  // ---- Discord: a real gateway session (IDENTIFY → MESSAGE_CREATE).
  function startDiscord() {
    const cfg = (ctx.getConfig().discord) || {};
    dcWant = !!(cfg.enabled && cfg.token);
    if (!dcWant) { state.discord = "off"; return; }
    state.discord = "connecting";
    const sock = wsConnect("gateway.discord.gg", "/?v=10&encoding=json", {
      onMsg: (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.s) dcSeq = m.s;
        if (m.op === 10) {           // HELLO → heartbeat + identify
          clearInterval(dcBeat);
          dcBeat = setInterval(() =>
            sock.send(JSON.stringify({ op: 1, d: dcSeq })), m.d.heartbeat_interval || 41250);
          sock.send(JSON.stringify({ op: 2, d: {
            token: cfg.token,
            // GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT
            intents: (1 << 9) | (1 << 12) | (1 << 15),
            properties: { os: "windows", browser: "bagidea-office", device: "bagidea-office" },
          } }));
        } else if (m.op === 0 && m.t === "READY") {
          state.discord = "on";
          log("discord ready as " + (m.d.user && m.d.user.username));
        } else if (m.op === 0 && m.t === "MESSAGE_CREATE") {
          const d = m.d;
          if (!d || !d.content || (d.author && d.author.bot)) return;
          if (cfg.channel && String(d.channel_id) !== String(cfg.channel)) return;
          const from = (d.author && (d.author.global_name || d.author.username)) || "discord user";
          ctx.onMessage("discord", from, d.content,
            (reply) => sendDiscord(cfg.token, d.channel_id, reply));
        } else if (m.op === 9) {      // invalid session → re-identify fresh
          try { sock.close(); } catch {}
        }
      },
      onClose: () => {
        clearInterval(dcBeat);
        if (dcWant) {
          state.discord = "reconnecting";
          setTimeout(startDiscord, 6000);
        } else state.discord = "off";
      },
    });
    dcSock = sock;
  }
  function sendDiscord(token, channelId, text) {
    const parts = chunk(String(text), 1900);
    const sendNext = (i) => {
      if (i >= parts.length) return;
      jreq("POST", "discord.com", `/api/v10/channels/${channelId}/messages`,
        { authorization: "Bot " + token }, { content: parts[i] }, () => sendNext(i + 1));
    };
    sendNext(0);
  }

  // ---- LINE: webhook in, push out (reply tokens die in a minute — agents
  // think longer than that, so we push to the user id instead).
  function lineWebhook(req, res, rawBody) {
    const cfg = (ctx.getConfig().line) || {};
    if (!cfg.enabled || !cfg.token) { res.writeHead(404); return res.end(); }
    if (cfg.secret) {
      const sig = crypto.createHmac("sha256", cfg.secret).update(rawBody).digest("base64");
      if (sig !== req.headers["x-line-signature"]) { res.writeHead(403); return res.end(); }
    }
    res.writeHead(200);
    res.end("ok");           // ack fast — LINE retries slow webhooks
    state.line = "on";
    let j;
    try { j = JSON.parse(rawBody.toString("utf8")); } catch { return; }
    for (const ev of j.events || []) {
      if (ev.type !== "message" || !ev.message || ev.message.type !== "text") continue;
      const to = ev.source && (ev.source.userId || ev.source.groupId);
      if (!to) continue;
      ctx.onMessage("line", "LINE user", ev.message.text, (reply) => {
        for (const part of chunk(String(reply), 4900))
          jreq("POST", "api.line.me", "/v2/bot/message/push",
            { authorization: "Bearer " + cfg.token },
            { to, messages: [{ type: "text", text: part }] }, () => {});
      });
    }
  }

  function chunk(s, n) {
    const out = [];
    for (let i = 0; i < s.length && out.length < 5; i += n) out.push(s.slice(i, i + n));
    return out.length ? out : [""];
  }

  function stopAll() {
    tgAlive = false;
    dcWant = false;
    clearInterval(dcBeat);
    if (dcSock) { try { dcSock.close(); } catch {} dcSock = null; }
  }

  return {
    restart() { stopAll(); setTimeout(() => { startTelegram(); startDiscord(); }, 300); },
    lineWebhook,
    status: () => ({ ...state }),
  };
};
