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
};

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
