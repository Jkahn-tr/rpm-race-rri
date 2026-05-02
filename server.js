"use strict";
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "rpm2025";
const RACE_DURATION_MS = 20000;

// ---- Options ----
const OPTIONS = [
  { id: 0, label: "Spend more time with family",    emoji: "👨‍👩‍👧" },
  { id: 1, label: "Start a side business",           emoji: "🚀" },
  { id: 2, label: "Travel somewhere new",            emoji: "✈️"  },
  { id: 3, label: "Exercise & get in shape",         emoji: "💪"  },
  { id: 4, label: "Learn a new skill",               emoji: "📚"  },
  { id: 5, label: "Rest. Seriously, just rest.",     emoji: "😴"  },
  { id: 6, label: "Give back / volunteer",           emoji: "🤝"  },
  { id: 7, label: "Scroll my phone but guilt-free",  emoji: "📱"  },
];

// ---- State ----
let state = {
  status: "waiting",   // waiting | open | racing | finished
  votes: Object.fromEntries(OPTIONS.map(o => [o.id, 0])),
  voters: new Map(),   // sessionId -> optionId
  raceStartedAt: null,
  winner: null,
};

const wss_clients = new Set();

// ---- Express ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type, x-admin-password");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function adminAuth(req, res, next) {
  if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---- Helpers ----
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
  for (const ws of wss_clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

function broadcastState() {
  broadcast({ type: "state", state: publicState() });
}

// ---- Player endpoints ----
app.get("/options", (req, res) => {
  res.json({ options: OPTIONS, state: publicState() });
});

app.post("/vote", (req, res) => {
  const { sessionId, optionId } = req.body;
  if (!sessionId || optionId === undefined) return res.status(400).json({ error: "missing fields" });
  if (state.status !== "open") return res.status(409).json({ error: "voting_closed", status: state.status });
  if (typeof optionId !== "number" || !OPTIONS[optionId]) return res.status(400).json({ error: "invalid option" });

  const prev = state.voters.get(sessionId);
  if (prev !== undefined) {
    // Change vote
    state.votes[prev] = Math.max(0, state.votes[prev] - 1);
  }
  state.voters.set(sessionId, optionId);
  state.votes[optionId]++;

  broadcastState();
  res.json({ ok: true, optionId, state: publicState() });
});

// ---- Admin endpoints ----
app.get("/admin/status", adminAuth, (req, res) => {
  res.json({ state: publicState(), options: OPTIONS });
});

app.post("/admin/open", adminAuth, (req, res) => {
  state.status = "open";
  broadcastState();
  res.json({ ok: true });
});

app.post("/admin/race", adminAuth, (req, res) => {
  if (state.status === "racing") return res.json({ ok: true, already: true });
  state.status = "racing";
  state.raceStartedAt = Date.now();
  broadcastState();

  // After RACE_DURATION_MS, compute and broadcast winner
  setTimeout(() => {
    const winner = Object.entries(state.votes)
      .sort((a, b) => b[1] - a[1])[0];
    state.winner = parseInt(winner[0]);
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
  wss_clients.add(ws);
  // Send current state on connect
  ws.send(JSON.stringify({ type: "state", state: publicState() }));
  ws.on("close", () => wss_clients.delete(ws));
  ws.on("error", () => wss_clients.delete(ws));
});

server.listen(PORT, () => console.log(`RPM Race server on :${PORT}`));
