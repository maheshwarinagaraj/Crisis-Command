const express = require("express"), cors = require("cors"), http = require("http");
const { Server } = require("socket.io"), { MongoClient } = require("mongodb");
const A = require("./agents");
if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) { console.error("AI-only mode: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY"); process.exit(1); }
const h = fn => (req, res) => fn(req, res).catch(e => { emit("Error", e.message); res.status(502).json({ error: e.message }); });

const app = express(); app.use(cors(), express.json()); app.use(express.static("public"));
const srv = http.createServer(app), io = new Server(srv, { cors: { origin: "*" } });

let state = { hq: { lat: 12.9716, lng: 77.5946 }, incidents: [], resources: [], blocked: [], dispatched: {}, plan: null, pending: null, audit: [] };
let col = null, seq = 0;
(async () => {
  if (!process.env.MONGO_URI) return console.log("No MONGO_URI → in-memory state");
  const c = await MongoClient.connect(process.env.MONGO_URI); col = c.db("crisismesh").collection("state");
  const s = await col.findOne({ _id: "live" }); if (s) { delete s._id; state = s; seq = state.incidents.length; }
  console.log("MongoDB connected");
})().catch(e => console.log("Mongo error:", e.message));

const save = () => col && col.replaceOne({ _id: "live" }, { _id: "live", ...state }, { upsert: true });
const emit = (agent, msg) => { const e = { agent, msg, at: Date.now() }; state.audit.push(e); io.emit("agent_log", e); };
const push = () => { save(); io.emit("state", state); };
const off = (hq, dx, dy) => ({ lat: hq.lat + dy * 0.009, lng: hq.lng + (dx * 0.009) / Math.cos((hq.lat * Math.PI) / 180) });

function seedResources(hq) {
  const R = [["ambulance", -1.2, .8], ["ambulance", 1.5, -.6], ["rescue", .4, 1.4], ["rescue", -1.6, -1], ["medical", 1.1, 1], ["shelter", -.3, -1.6], ["shelter", 1.8, .4], ["shelter", -1.9, 1.2]];
  state.resources = R.map((r, i) => ({ id: "R" + (i + 1), type: r[0], ...off(hq, r[1], r[2]), available: true }));
}
async function replan(event) {
  state.plan = await A.command(state, event, emit);
  if (state.plan.needsApproval) { state.pending = state.plan; emit("Approval", "Human decision requested"); }
  else { state.dispatched = state.plan.assignments; state.pending = null; emit("Approval", "Auto-dispatched (low impact)"); }
  push();
}
seedResources(state.hq);

// Live geolocation from the browser: recenters HQ + resources
app.post("/api/location", h(async (req, res) => {
  const { lat, lng } = req.body; if (typeof lat !== "number" || typeof lng !== "number") return res.status(400).json({ error: "lat,lng required" });
  state.hq = { lat, lng }; seedResources(state.hq); state.incidents = []; state.blocked = []; state.dispatched = {}; state.plan = null; state.pending = null;
  emit("Geo", `HQ set to ${lat.toFixed(5)}, ${lng.toFixed(5)}`); push(); res.json({ ok: true });
}));
// Reporter/responder live positions (GPS of units)
app.post("/api/resources/:id/position", (req, res) => {
  const r = state.resources.find(x => x.id === req.params.id); if (!r) return res.sendStatus(404);
  r.lat = req.body.lat; r.lng = req.body.lng; io.emit("state", state); res.json({ ok: true });
});
app.get("/api/state", (_, res) => res.json(state));

// Free-text incident (or structured) → Assessment → replan
app.post("/api/incidents", h(async (req, res) => {
  const { text, lat, lng } = req.body;
  const loc = lat != null ? { lat, lng } : (() => { const a = Math.random() * 6.28, d = 1 + Math.random() * 1.8; return off(state.hq, Math.cos(a) * d, Math.sin(a) * d); })();
  const inc = { id: "I" + ++seq, ...(await A.assess(text || "unknown emergency", loc)) };
  state.incidents.push(inc); emit("Assessment", `${inc.id} ${inc.type} sev ${inc.severity} conf ${inc.confidence}${inc.missing?.length ? " missing: " + inc.missing.join(",") : ""}`);
  await replan("New incident " + inc.id); res.json(inc);
}));
app.post("/api/resources/:id/fail", h(async (req, res) => {
  const r = state.resources.find(x => x.id === req.params.id); if (!r) return res.sendStatus(404);
  r.available = false; emit("Resource", r.id + " unavailable"); await replan(r.id + " failed"); res.json({ ok: true });
}));
app.post("/api/blocks", h(async (req, res) => {
  state.blocked.push(req.body.incidentId); emit("Route", "Blocked: " + req.body.incidentId); await replan("Route blocked"); res.json({ ok: true });
}));
app.post("/api/approval", h(async (req, res) => {
  if (!state.pending) return res.status(400).json({ error: "nothing pending" });
  const ok = req.body.decision === "approve";
  if (ok) state.dispatched = state.pending.assignments;
  emit("Approval", `${ok ? "APPROVED" : "REJECTED"} by ${req.body.operator || "commander"}`);
  state.pending = null; push(); res.json({ ok });
}));

io.on("connection", s => s.emit("state", state));
srv.listen(process.env.PORT || 4000, () => console.log("CrisisMesh API on :" + (process.env.PORT || 4000)));
