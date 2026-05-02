"use strict";
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "rpm2025";
const RACE_DURATION_MS = 20000;

// ---- Options ----
const OPTIONS = [
  { id: 0, label: "Spend more time with family",    emoji: "👨‍👩‍👧" },
  { id: 1, label: "Start a side business",           emoji: "🚀"  },
  { id: 2, label: "Travel somewhere new",            emoji: "✈️"  },
  { id: 3, label: "Exercise & get in shape",         emoji: "💪"  },
  { id: 4, label: "Learn a new skill",               emoji: "📚"  },
  { id: 5, label: "Rest. Seriously, just rest.",     emoji: "😴"  },
  { id: 6, label: "Give back / volunteer",           emoji: "🤝"  },
  { id: 7, label: "Scroll my phone but guilt-free",  emoji: "📱"  },
];

// ---- State ----
// Statuses:
//   waiting   → QR code on big screen, players see "get ready" screen
//   preview   → Question + options on big screen (no counts), players still see "get ready"
//   racing    → Traffic light + race on big screen, players can vote
//   finished  → Winner shown everywhere
let state = {
  status: "waiting",
  votes: Object.fromEntries(OPTIONS.map(o => [o.id, 0])),
  voters: new Map(),   // sessionId -> optionId
  raceStartedAt: null,
  winner: null,
};

const clients = new Set();

// ---- Express ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type, x-admin-password");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function adminAuth(req, res, next) {
  if (req.headers["x-admin-password"] !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "unauthorized" });
  next();
}

function publicState() {
  return {
    status: state.status,
    votes: state.votes,
    raceStartedAt: state.raceStartedAt,
    winner: state.winner,
    totalVotes: Object.values(state.votes).reduce((a, b) => a + b, 0),
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) try { ws.send(data); } catch (_) {}
  }
}

// ---- Player: get options & state ----
app.get("/options", (req, res) => {
  res.json({ options: OPTIONS, state: publicState() });
});

// ---- Player: vote (only accepted during "racing") ----
app.post("/vote", (req, res) => {
  const { sessionId, optionId } = req.body;
  if (!sessionId || optionId === undefined)
    return res.status(400).json({ error: "missing fields" });
  if (state.status !== "racing")
    return res.status(409).json({ error: "voting_closed", status: state.status, state: publicState() });
  if (typeof optionId !== "number" || optionId < 0 || optionId >= OPTIONS.length)
    return res.status(400).json({ error: "invalid option" });

  const prev = state.voters.get(sessionId);
  if (prev !== undefined) state.votes[prev] = Math.max(0, state.votes[prev] - 1);
  state.voters.set(sessionId, optionId);
  state.votes[optionId]++;

  broadcast({ type: "state", state: publicState() });
  res.json({ ok: true, optionId, state: publicState() });
});

// ---- Admin ----
app.get("/admin/status", adminAuth, (req, res) => {
  res.json({ state: publicState(), options: OPTIONS });
});

// Preview: show question on big screen, players still waiting
app.post("/admin/preview", adminAuth, (req, res) => {
  if (state.status !== "waiting") return res.json({ ok: false, reason: "not in waiting" });
  state.status = "preview";
  broadcast({ type: "state", state: publicState() });
  res.json({ ok: true });
});

// Start race: players can now vote, traffic light + race begins on big screen
app.post("/admin/race", adminAuth, (req, res) => {
  if (state.status === "racing") return res.json({ ok: true, already: true });
  // Allow jumping straight from waiting or preview
  state.status = "racing";
  state.raceStartedAt = Date.now();
  broadcast({ type: "state", state: publicState() });

  // Close voting and announce winner after RACE_DURATION_MS
  setTimeout(() => {
    const sorted = Object.entries(state.votes).sort((a, b) => b[1] - a[1]);
    state.winner = parseInt(sorted[0][0]);
    state.status = "finished";
    broadcast({ type: "finished", winner: state.winner, state: publicState() });
  }, RACE_DURATION_MS);

  res.json({ ok: true, raceStartedAt: state.raceStartedAt });
});

app.post("/admin/reset", adminAuth, (req, res) => {
  broadcast({ type: "reset" });
  setTimeout(() => {
    state.status = "waiting";
    state.votes = Object.fromEntries(OPTIONS.map(o => [o.id, 0]));
    state.voters.clear();
    state.raceStartedAt = null;
    state.winner = null;
  }, 300);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "state", state: publicState() }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

server.listen(PORT, () => console.log(`RPM Race on :${PORT}`));
