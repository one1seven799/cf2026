const MGTV_API = `https://vote.api.mgtv.com/chengfeng/query_vote_list?os=win&did=f86d8e2a-eaa6-4878-a689-579d6dec2555&source=share_cf_zj_2026&invoker=mobile-zhipubao&appVersion=6.9.9_vipact&mac=f86d8e2a-eaa6-4878-a689-579d6dec2555&version=6.9.9_vipact`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function listAllSnapKeys(env) {
  const keys = [];
  let cursor;
  let pages = 0;
  const MAX_PAGES = 10; // KV.list returns up to 1000 keys/page; 10 pages = 10000 keys max
  do {
    const res = await env.KV.list({ prefix: "snap:", cursor });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return keys;
}

async function fetchAndSave(env) {
  const t = Date.now();
  const apiUrl = `${MGTV_API}&t=${t}&request_time=${t}`;

  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://www.mgtv.com/",
    },
  });
  const data = await resp.json();
  if (data.errno !== 0) throw new Error(data.errmsg || "API error");

  const rows = [];
  for (const p of data.data.vote_list) {
    const voteOpt = p.option_name.find(o => o.option_name === "夯爆了");
    rows.push({ name: p.vote_name, votes: voteOpt?.option_vote_number ?? 0 });
  }
  rows.sort((a, b) => b.votes - a.votes);
  rows.forEach((r, i) => r.rank = i + 1);

  const ts = new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString().replace("T", " ").substring(0, 19);

  // 读取最近一条快照，填 prevTs 和 hourStartTs
  let prevTs = null;
  let hourStartTs = null;
  try {
    const keys = await listAllSnapKeys(env);
    if (keys.length > 0) {
      keys.sort();
      const lastKey = keys[keys.length - 1];
      const lastRaw = await env.KV.get(lastKey);
      if (lastRaw) {
        const lastSnap = JSON.parse(lastRaw);
        prevTs = lastSnap.ts;
        // hourStartTs: 找本小时最早的一条
        const curHourPrefix = ts.substring(0, 13);
        const hourKeys = keys.filter(k => k.startsWith("snap:" + curHourPrefix));
        if (hourKeys.length > 0) {
          hourKeys.sort();
          const hourRaw = await env.KV.get(hourKeys[0]);
          if (hourRaw) hourStartTs = JSON.parse(hourRaw).ts;
        } else {
          hourStartTs = prevTs;
        }
      }
    }
  } catch (e) {
    // 读取失败不影响主流程
  }

  const snap = {
    ts,
    rows:      rows.filter(r => r.rank >= 2 && r.rank <= 4),
    watchRows: rows.filter(r => r.rank >= 5 && r.rank <= 9),
    prevTs,
    hourStartTs,
    savedBy:   "cron",
  };

  await env.KV.put("snap:" + ts, JSON.stringify(snap));
  return snap;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method === "POST" && url.pathname === "/snapshots") {
      try {
        const body = await request.json();
        const snaps = body.snapshots;
        if (!Array.isArray(snaps) || snaps.length === 0)
          return json({ ok: false, error: "empty" }, 400);

        // Limit to avoid exceeding KV operation limits (free tier: 1000 ops/invocation)
        const MAX_UPLOAD = 100;
        const toSave = snaps.slice(-MAX_UPLOAD); // keep most recent if oversized

        // Write in serial batches of 50 to avoid KV burst limits
        const BATCH = 50;
        let saved = 0;
        for (let i = 0; i < toSave.length; i += BATCH) {
          const batch = toSave.slice(i, i + BATCH);
          await Promise.all(batch.map(s => env.KV.put("snap:" + s.ts, JSON.stringify(s))));
          saved += batch.length;
        }
        return json({ ok: true, saved });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/snapshots") {
      try {
        // Limit to most recent MAX_SNAP keys to avoid exceeding KV operation limits
        // (Cloudflare free tier: 1000 KV ops per Worker invocation)
        const MAX_SNAP = 400; // list + get = 2 ops each; 400*2 = 800, safely under 1000

        const keys = await listAllSnapKeys(env);
        if (!keys.length) return json({ ok: true, snapshots: [] });

        // Sort keys so we take the newest ones (keys are "snap:YYYY-MM-DD HH:MM:SS")
        keys.sort();
        const recentKeys = keys.slice(-MAX_SNAP);

        // Fetch in small serial batches to avoid bursting KV ops
        const BATCH = 50;
        const snapshots = [];
        for (let i = 0; i < recentKeys.length; i += BATCH) {
          const batch = recentKeys.slice(i, i + BATCH);
          const vals = await Promise.all(batch.map(k => env.KV.get(k)));
          for (const v of vals) {
            if (!v) continue;
            try { snapshots.push(JSON.parse(v)); } catch {}
          }
        }

        snapshots.sort((a, b) => a.ts.localeCompare(b.ts));
        return json({ ok: true, snapshots, total_keys: keys.length, returned: snapshots.length });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/cron-now") {
      try {
        const snap = await fetchAndSave(env);
        return json({ ok: true, ts: snap.ts, ranks: snap.rows.map(r => `#${r.rank} ${r.name} ${r.votes}`) });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    const t = Date.now();
    const apiUrl = `${MGTV_API}&t=${t}&request_time=${t}`;
    try {
      const resp = await fetch(apiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.mgtv.com/",
        },
      });
      const body = await resp.text();
      return new Response(body, {
        headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
      });
    } catch (e) {
      return json({ errno: -1, errmsg: e.message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndSave(env));
  },
};
