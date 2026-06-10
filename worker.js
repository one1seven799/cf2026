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

// ─── KV 工具：用 list 分页读取所有 snap key ───────────────────────────────
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

// ─── 核心：抓票数并存 KV（每次只写1条，不维护 index）────────────────────────
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

  const snap = {
    ts,
    rows:      rows.filter(r => r.rank >= 2 && r.rank <= 4),
    watchRows: rows.filter(r => r.rank >= 5 && r.rank <= 9),
    savedBy:   "cron",
  };

  // 只写这 1 次，不更新 index —— 节省 KV 写入配额
  await env.KV.put("snap:" + ts, JSON.stringify(snap));
  return snap;
}

export default {
  // ─── HTTP 请求处理 ────────────────────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // POST /snapshots — 网页开着时批量上传快照
    if (request.method === "POST" && url.pathname === "/snapshots") {
      try {
        const body = await request.json();
        const snaps = body.snapshots;
        if (!Array.isArray(snaps) || snaps.length === 0)
          return json({ ok: false, error: "empty" }, 400);

        // 每条写1次，不维护 index
        await Promise.all(snaps.map(s => env.KV.put("snap:" + s.ts, JSON.stringify(s))));
        return json({ ok: true, saved: snaps.length });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // GET /snapshots — 网页启动时拉取全量历史
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

    // GET /cron-now — 手动触发一次抓取（调试用）
    if (request.method === "GET" && url.pathname === "/cron-now") {
      try {
        const snap = await fetchAndSave(env);
        return json({ ok: true, ts: snap.ts, ranks: snap.rows.map(r => `#${r.rank} ${r.name} ${r.votes}`) });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // GET / — 代理 mgtv API（网页直接抓票用）
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

  // ─── Cron 定时触发（wrangler.toml 里配置频率）────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndSave(env));
  },
};
