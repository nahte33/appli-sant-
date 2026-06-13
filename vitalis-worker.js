/* =====================================================================
   VITALIS — Cloudflare Worker
   Reçoit les données de Health Auto Export (POST) et les sert à l'app
   Vitalis (GET). À coller dans le tableau de bord Cloudflare.

   PRÉREQUIS (voir le guide GUIDE-SYNC.md) :
     • un KV namespace lié au Worker, nommé exactement :  HEALTH
     • deux variables d'environnement :
         WRITE_TOKEN  → secret que Health Auto Export enverra (POST)
         READ_TOKEN   → jeton que l'app Vitalis utilisera (GET)
   ===================================================================== */

const MAX_DAYS = 120; // on ne garde que les 120 derniers jours (borne la taille)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,content-type",
    };

    // Pré-vol CORS (au cas où)
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // -------- /state : sauvegarde de l'état de l'app (sync multi-appareils) --------
    // L'app pousse son état complet (séances, notes, compléments, réglages) après
    // chaque modification, et le relit à l'ouverture. Authentifié par READ_TOKEN
    // (le jeton personnel de l'app) — WRITE_TOKEN reste réservé à Health Auto Export.
    if (url.pathname.endsWith("/state")) {
      const token = url.searchParams.get("token");
      if (token !== env.READ_TOKEN) return json({ error: "unauthorized" }, 401, cors);

      if (req.method === "POST") {
        let state;
        try { state = await req.json(); }
        catch { return json({ error: "invalid json" }, 400, cors); }
        if (!state || typeof state.rev !== "number")
          return json({ error: "missing rev" }, 400, cors);
        // protection : on n'écrase pas un état plus récent (écriture concurrente)
        const cur = await env.HEALTH.get("appstate");
        if (cur) {
          try {
            const curRev = JSON.parse(cur).rev || 0;
            if (curRev > state.rev) return json({ ok: false, stale: true, rev: curRev }, 409, cors);
          } catch {}
        }
        await env.HEALTH.put("appstate", JSON.stringify(state));
        return json({ ok: true, rev: state.rev }, 200, cors);
      }

      if (req.method === "GET") {
        const stored = await env.HEALTH.get("appstate");
        return new Response(stored || "null", { headers: { ...cors, "Content-Type": "application/json" } });
      }

      return json({ error: "method not allowed" }, 405, cors);
    }

    // -------- /push : notifications quotidiennes (Web Push) --------
    // /push/key        GET  → clé publique VAPID (générée et stockée au 1er appel)
    // /push/subscribe  POST → enregistre l'abonnement du navigateur
    // /push/unsubscribe POST → le retire
    // /push/test       POST → envoie une notification immédiatement
    if (url.pathname.includes("/push/")) {
      const token = url.searchParams.get("token");
      if (token !== env.READ_TOKEN) return json({ error: "unauthorized" }, 401, cors);

      if (url.pathname.endsWith("/push/key") && req.method === "GET") {
        const v = await getVapid(env);
        return json({ key: v.publicRaw }, 200, cors);
      }
      if (url.pathname.endsWith("/push/subscribe") && req.method === "POST") {
        let sub; try { sub = await req.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
        if (!sub || !sub.endpoint || !sub.keys) return json({ error: "invalid subscription" }, 400, cors);
        const subs = JSON.parse((await env.HEALTH.get("subs")) || "[]")
          .filter(s => s.endpoint !== sub.endpoint);
        subs.push(sub);
        await env.HEALTH.put("subs", JSON.stringify(subs));
        return json({ ok: true, count: subs.length }, 200, cors);
      }
      if (url.pathname.endsWith("/push/unsubscribe") && req.method === "POST") {
        let b; try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
        const subs = JSON.parse((await env.HEALTH.get("subs")) || "[]")
          .filter(s => s.endpoint !== (b && b.endpoint));
        await env.HEALTH.put("subs", JSON.stringify(subs));
        return json({ ok: true, count: subs.length }, 200, cors);
      }
      if (url.pathname.endsWith("/push/test") && req.method === "POST") {
        const n = await sendDaily(env, true);
        return json({ ok: true, sent: n }, 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    }

    // -------- POST : réception depuis Health Auto Export --------
    if (req.method === "POST") {
      const auth = req.headers.get("authorization") || "";
      if (auth !== "Bearer " + env.WRITE_TOKEN)
        return json({ error: "unauthorized" }, 401, cors);

      let incoming;
      try { incoming = await req.json(); }
      catch { return json({ error: "invalid json" }, 400, cors); }

      const stored = JSON.parse(
        (await env.HEALTH.get("payload")) || '{"data":{"metrics":[],"workouts":[]}}'
      );
      merge(stored, incoming);
      prune(stored, MAX_DAYS);
      await env.HEALTH.put("payload", JSON.stringify(stored));

      return json({
        ok: true,
        metrics: stored.data.metrics.length,
        workouts: stored.data.workouts.length,
      }, 200, cors);
    }

    // -------- GET : lecture par l'app Vitalis --------
    if (req.method === "GET") {
      const token = url.searchParams.get("token");
      if (token !== env.READ_TOKEN) return json({ error: "unauthorized" }, 401, cors);
      const stored = (await env.HEALTH.get("payload")) || '{"data":{"metrics":[],"workouts":[]}}';
      return new Response(stored, { headers: { ...cors, "Content-Type": "application/json" } });
    }

    return json({ error: "method not allowed" }, 405, cors);
  },

  // Cron toutes les 15 min : digest du matin (~05h30 UTC) + rappels de compléments à l'heure.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

async function runScheduled(env) {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  // digest quotidien autour de 05h30 UTC (fenêtre de 15 min alignée sur le cron)
  if (utcMin >= 330 && utcMin < 345) await sendDaily(env, false);
  await sendReminders(env);
}

// Rappels de prise : pour chaque complément avec un rappel activé, envoie une notif
// à son heure locale s'il n'est pas encore coché ce jour-là. Dédoublonné par jour.
async function sendReminders(env) {
  const subs = JSON.parse((await env.HEALTH.get("subs")) || "[]");
  if (!subs.length) return 0;
  const state = JSON.parse((await env.HEALTH.get("appstate")) || "null");
  if (!state || !Array.isArray(state.supps)) return 0;
  const sentMap = JSON.parse((await env.HEALTH.get("remind_sent")) || "{}");
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const due = [];
  for (const s of state.supps) {
    if (!s || !s.remindOn || !s.remindAt) continue;
    const [h, m] = String(s.remindAt).split(":").map(Number);
    if (isNaN(h) || isNaN(m)) continue;
    const off = (typeof s.remindTz === "number") ? s.remindTz : 0; // minutes à l'est de UTC
    const localNowMin = (utcMin + off + 1440) % 1440;
    const localDate = new Date(now.getTime() + off * 60000).toISOString().slice(0, 10);
    const targetMin = h * 60 + m;
    let diff = localNowMin - targetMin;
    if (diff < 0) diff += 1440;
    if (diff >= 15) continue;                       // hors de la fenêtre de déclenchement
    if (sentMap[s.id] === localDate) continue;      // déjà notifié aujourd'hui
    if (s.log && s.log[localDate]) { sentMap[s.id] = localDate; continue; } // déjà pris
    due.push(s); sentMap[s.id] = localDate;
  }
  await env.HEALTH.put("remind_sent", JSON.stringify(sentMap));
  if (!due.length) return 0;
  const keep = []; let sent = 0;
  for (const sub of subs) {
    let alive = true;
    for (const s of due) {
      try {
        const st = await sendPush(env, sub, {
          title: "Vitalis — rappel 💊",
          body: "C'est l'heure de prendre : " + s.name + (s.dosage ? " (" + s.dosage + ")" : ""),
          url: "./",
        });
        if (st === 404 || st === 410) { alive = false; break; }
        if (st >= 200 && st < 300) sent++;
      } catch (e) { /* on garde l'abonnement, réessai au prochain tick */ }
    }
    if (alive) keep.push(sub);
  }
  if (keep.length !== subs.length) await env.HEALTH.put("subs", JSON.stringify(keep));
  return sent;
}

/* ==================== Web Push (RFC 8291 / VAPID) ==================== */

const b64u = {
  enc(buf) { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "=";
    const bin = atob(str); return Uint8Array.from(bin, c => c.charCodeAt(0)); },
};
function concatBuf(...arrs) { const len = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }

// Paire de clés VAPID auto-générée au premier appel et conservée dans le KV
async function getVapid(env) {
  let v = await env.HEALTH.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    v = {
      privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
      publicRaw: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)),
    };
    await env.HEALTH.put("vapid", JSON.stringify(v));
  }
  return v;
}

async function vapidAuth(env, endpoint) {
  const v = await getVapid(env);
  const enc = new TextEncoder();
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:push@vitalis.app",
  })));
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${v.publicRaw}`;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// Chiffrement du payload pour un abonnement (aes128gcm, RFC 8291)
async function encryptPayload(sub, text) {
  const enc = new TextEncoder();
  const uaPub = b64u.dec(sub.keys.p256dh);   // clé publique du navigateur (65 octets)
  const auth = b64u.dec(sub.keys.auth);      // secret d'authentification (16 octets)
  const asKp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKp.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKp.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concatBuf(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = concatBuf(enc.encode(text), new Uint8Array([2])); // 0x02 = délimiteur du dernier bloc
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const header = new Uint8Array(16 + 4 + 1 + 65);  // salt | rs | idlen | clé publique éphémère
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return concatBuf(header, cipher);
}

async function sendPush(env, sub, payload) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "TTL": "86400",
      "Urgency": "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Authorization": await vapidAuth(env, sub.endpoint),
    },
    body,
  });
  return res.status;
}

// Construit et envoie la notification du jour à tous les appareils abonnés.
// Contenu tiré de l'état de l'app dans le KV : séances programmées + compléments.
async function sendDaily(env, isTest) {
  const subs = JSON.parse((await env.HEALTH.get("subs")) || "[]");
  if (!subs.length) return 0;
  const state = JSON.parse((await env.HEALTH.get("appstate")) || "null");
  const today = new Date().toISOString().slice(0, 10);
  const plans = state && Array.isArray(state.plan) ? state.plan.filter(p => p.date === today) : [];
  const nSupps = state && Array.isArray(state.supps) ? state.supps.length : 0;
  let body = plans.length
    ? "🏋️ " + plans.map(p => p.label || "Séance").join(" · ")
    : "Pas de séance programmée — jour de récupération ?";
  if (nSupps) body += "\n💊 " + nSupps + " complément(s) à prendre";
  const payload = { title: isTest ? "Vitalis — test ✓" : "Vitalis — ton programme du jour", body, url: "./" };
  const keep = []; let sent = 0;
  for (const sub of subs) {
    try {
      const st = await sendPush(env, sub, payload);
      if (st === 404 || st === 410) continue; // abonnement mort : on le retire
      keep.push(sub); if (st >= 200 && st < 300) sent++;
    } catch (e) { keep.push(sub); }
  }
  if (keep.length !== subs.length) await env.HEALTH.put("subs", JSON.stringify(keep));
  return sent;
}

/* -------------------- utilitaires -------------------- */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function dayKey(s) { return (s || "").slice(0, 10); }

// Fusionne un nouveau payload HAE dans le stock, sans doublons.
function merge(store, inc) {
  const d = (inc && inc.data) ? inc.data : (inc || {});

  // métriques : fusion par nom, dédoublonnage par date
  (d.metrics || []).forEach(m => {
    let ex = store.data.metrics.find(x => x.name === m.name);
    if (!ex) { ex = { name: m.name, units: m.units, data: [] }; store.data.metrics.push(ex); }
    const seen = new Set(ex.data.map(p => p.date || p.startDate));
    (m.data || []).forEach(p => {
      const k = p.date || p.startDate;
      if (!seen.has(k)) { ex.data.push(p); seen.add(k); }
    });
  });

  // entraînements : dédoublonnage par id (ou nom+début)
  const wseen = new Set(store.data.workouts.map(w => w.id || (w.name + "|" + w.start)));
  (d.workouts || []).forEach(w => {
    const k = w.id || (w.name + "|" + w.start);
    if (!wseen.has(k)) { store.data.workouts.push(w); wseen.add(k); }
  });
}

// Supprime les points plus vieux que maxDays.
function prune(store, maxDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const cut = cutoff.toISOString().slice(0, 10);
  store.data.metrics.forEach(m => {
    m.data = (m.data || []).filter(p => dayKey(p.date || p.startDate) >= cut);
  });
  store.data.workouts = store.data.workouts.filter(w => dayKey(w.start) >= cut);
}
