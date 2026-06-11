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
  do {
    const res = await env.KV.list({ prefix: "snap:", cursor });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
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
        await Promise.all(snaps.map(s => env.KV.put("snap:" + s.ts, JSON.stringify(s))));
        return json({ ok: true, saved: snaps.length });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/snapshots") {
      try {
        const keys = await listAllSnapKeys(env);
        if (!keys.length) return json({ ok: true, snapshots: [] });
        const vals = await Promise.all(keys.map(k => env.KV.get(k)));
        const snapshots = vals
          .filter(Boolean)
          .map(v => { try { return JSON.parse(v); } catch { return null; } })
          .filter(Boolean)
          .sort((a, b) => a.ts.localeCompare(b.ts));
        return json({ ok: true, snapshots });
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
