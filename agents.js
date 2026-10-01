// Six agents. Facts come from state; LLM only reasons. Hard constraints are deterministic.
const SPEED = { ambulance: 55, rescue: 45, medical: 40, shelter: 35 }; // km/h
const GEM = process.env.GEMINI_API_KEY, KEY = process.env.ANTHROPIC_API_KEY;
const GEM_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const km = (a, b) => {
  const r = x => (x * Math.PI) / 180, dl = r(b.lat - a.lat), dg = r(b.lng - a.lng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

async function llm(system, user) {
  if (!GEM && !KEY) throw new Error("Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY");
  try {
    if (GEM) { // Google AI Studio (free tier)
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEM_MODEL}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEM },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }] }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || null;
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 600, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    return d.content?.map(c => c.text || "").join("") || null;
  } catch (e) { throw new Error("LLM call failed: " + e.message); }
}

// Agent 1 — Incident Assessment
async function assess(text, loc) {
  const out = await llm(
    'Extract emergency facts. Reply ONLY JSON: {"type":string,"severity":1-4,"population":int,"needs":array of "ambulance"|"rescue"|"medical"|"shelter","missing":array of strings,"confidence":0-1}. Never invent facts; list unknowns in missing.',
    text);
  try { return { ...JSON.parse(out.replace(/```json|```/g, "").trim()), ...loc, text }; }
  catch { throw new Error("Assessment agent returned no valid AI output"); }
}

// Agent 2 — Priority Management
function prioritize(inc) {
  inc.score = inc.severity * 10 + Math.min(inc.population, 200) / 8 + (inc.vulnerable ? 5 : 0);
  inc.level = inc.score >= 45 ? "CRITICAL" : inc.score >= 32 ? "HIGH" : "MEDIUM";
  inc.reason = `severity ${inc.severity}, ~${inc.population} affected → score ${inc.score.toFixed(1)}`;
}

// Agent 4 — Route & Logistics (OSRM with haversine fallback)
async function route(res, inc, blocked) {
  let dist = km(res, inc) * 1.3, source = "estimate";
  try {
    const u = `https://router.project-osrm.org/route/v1/driving/${res.lng},${res.lat};${inc.lng},${inc.lat}?overview=false`;
    const d = await (await fetch(u, { signal: AbortSignal.timeout(2500) })).json();
    if (d.routes?.[0]) { dist = d.routes[0].distance / 1000; source = "osrm"; }
  } catch {}
  const detour = blocked.has(inc.id) ? 1.5 : 1;
  return { km: +dist.toFixed(2), eta: Math.round((dist / SPEED[res.type]) * 60 * detour + 2), detour: detour > 1, source };
}

// Agent 3 — Resource Allocation (deterministic; never invents resources)
function allocate(state) {
  const used = new Set(), assignments = {}, shortages = [];
  [...state.incidents].sort((a, b) => b.score - a.score).forEach(i => {
    assignments[i.id] = [];
    i.needs.forEach(t => {
      let best = null, bd = 1e9;
      state.resources.forEach(r => {
        if (r.type === t && r.available && !used.has(r.id)) { const d = km(r, i); if (d < bd) { bd = d; best = r; } }
      });
      best ? (used.add(best.id), assignments[i.id].push({ resourceId: best.id, type: t })) : shortages.push({ incidentId: i.id, type: t });
    });
  });
  return { assignments, shortages };
}

// Agent 5 — Command & Planning
async function command(state, event, emit) {
  state.incidents.forEach(prioritize);
  emit("Priority", state.incidents.sort((a, b) => b.score - a.score).map(i => `${i.id}:${i.level}`).join(" > "));
  const { assignments, shortages } = allocate(state);
  emit("Resource", shortages.length ? "Shortage: " + shortages.map(s => `${s.type}→${s.incidentId}`).join(", ") : "All needs covered");
  const blocked = new Set(state.blocked);
  for (const id in assignments) {
    const inc = state.incidents.find(i => i.id === id);
    for (const a of assignments[id]) {
      const r = state.resources.find(x => x.id === a.resourceId);
      Object.assign(a, await route(r, inc, blocked));
      if (a.detour) emit("Route", `${inc.id} blocked → detour, ETA ${a.eta} min`);
    }
  }
  const changed = Object.keys(state.dispatched || {}).filter(id => {
    const o = (state.dispatched[id] || []).map(a => a.resourceId).sort().join(), n = (assignments[id] || []).map(a => a.resourceId).sort().join();
    return o && o !== n;
  });
  const needsApproval = shortages.length > 0 || changed.length > 0;
  const plan = { assignments, shortages, changed, event, needsApproval, at: Date.now() };
  plan.explanation = await explain(plan, state);
  emit("Command", "Plan rebuilt");
  return plan;
}

// Agent 6 — Human Approval & Explanation
async function explain(plan, state) {
  const facts = JSON.stringify({ event: plan.event, incidents: state.incidents.map(i => ({ id: i.id, level: i.level, reason: i.reason })), assignments: plan.assignments, shortages: plan.shortages, changed: plan.changed });
  const t = await llm("You are an emergency command explainer. In <=4 sentences explain the allocation trade-offs using ONLY the given facts. Mention shortages and what the human must decide.", facts);
  return t;
}

module.exports = { assess, prioritize, command, km };
