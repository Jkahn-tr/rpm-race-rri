#!/usr/bin/env node
/**
 * RPM Race — Load Test
 * Simulates N concurrent voters joining, connecting via WS, and voting.
 * Usage: node load-test.js [voters] [ramp-ms]
 */
"use strict";

const http  = require("http");
const https = require("https");
const { WebSocket } = require("ws");
const { randomUUID } = require("crypto");

const BACKEND   = "https://rpm-race-rri.fly.dev";
const WS_URL    = "wss://rpm-race-rri.fly.dev/ws";
const VOTERS    = parseInt(process.argv[2] || "2500");
const RAMP_MS   = parseInt(process.argv[3] || "8000");  // spread connections over this window
const OPTIONS   = 8;

// ---- helpers ----
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, res => {
      let s = "";
      res.on("data", c => s += c);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }));
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

// ---- metrics ----
let wsConnected = 0, wsErrors = 0, wsMessages = 0;
let votesOk = 0, votesClosed = 0, votesErr = 0;
let minVoteMs = Infinity, maxVoteMs = 0, totalVoteMs = 0;
const start = Date.now();

function elapsed() { return ((Date.now() - start) / 1000).toFixed(1) + "s"; }

// ---- run ----
async function main() {
  console.log(`\n🏁 RPM Race Load Test`);
  console.log(`   Voters: ${VOTERS}  |  Ramp: ${RAMP_MS}ms  |  Target: ${BACKEND}\n`);

  // 1. Get initial state (also warms connection)
  const init = await new Promise((resolve, reject) => {
    https.get(BACKEND + "/options", res => {
      let s = ""; res.on("data", c => s += c);
      res.on("end", () => resolve(JSON.parse(s)));
    }).on("error", reject);
  });
  console.log(`✅ Server reachable — status: ${init.state.status}`);

  // 2. Spawn voters
  const interval = RAMP_MS / VOTERS;
  const voters = [];

  for (let i = 0; i < VOTERS; i++) {
    await new Promise(r => setTimeout(r, interval));
    spawnVoter(i);
  }

  console.log(`[${elapsed()}] All ${VOTERS} voters spawned, waiting for connections + votes to complete…`);

  // 3. Wait for all votes to settle (max 30s after last spawn)
  await new Promise(r => setTimeout(r, 15000));

  // 4. Report
  const elapsedMs = Date.now() - start;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`📊 RESULTS (total time: ${(elapsedMs/1000).toFixed(1)}s)`);
  console.log(`${"─".repeat(50)}`);
  console.log(`WebSocket connections:`);
  console.log(`  ✅ Connected:    ${wsConnected} / ${VOTERS}`);
  console.log(`  ❌ Errors:       ${wsErrors}`);
  console.log(`  📨 WS messages:  ${wsMessages}`);
  console.log(`\nVotes:`);
  console.log(`  ✅ OK:           ${votesOk}`);
  console.log(`  ⏱  Closed:       ${votesClosed} (arrived before race started)`);
  console.log(`  ❌ Errors:       ${votesErr}`);
  if (votesOk > 0) {
    console.log(`  ⚡ Latency:      min=${minVoteMs}ms  max=${maxVoteMs}ms  avg=${Math.round(totalVoteMs/votesOk)}ms`);
  }

  const successRate = Math.round((votesOk / VOTERS) * 100);
  console.log(`\n${successRate >= 95 ? "✅" : successRate >= 80 ? "⚠️ " : "❌"} Vote success rate: ${successRate}%`);
  if (wsConnected < VOTERS * 0.95) console.log("⚠️  WS connection rate below 95% — possible connection ceiling");
  console.log(`${"─".repeat(50)}\n`);

  process.exit(0);
}

function spawnVoter(i) {
  const sessionId = randomUUID();
  const optionId  = i % OPTIONS; // spread votes evenly

  // Connect WS
  let ws;
  try {
    ws = new WebSocket(WS_URL, { handshakeTimeout: 10000 });
  } catch(e) { wsErrors++; return; }

  ws.on("open",  ()  => { wsConnected++; });
  ws.on("message", () => { wsMessages++; });
  ws.on("error", ()  => { wsErrors++; });

  // Vote after a random delay 0–5s (simulates human think time)
  const delay = Math.random() * 5000;
  setTimeout(async () => {
    try {
      const t = Date.now();
      const r = await post(BACKEND + "/vote", { sessionId, optionId });
      const ms = Date.now() - t;
      if (r.status === 200) {
        votesOk++;
        minVoteMs = Math.min(minVoteMs, ms);
        maxVoteMs = Math.max(maxVoteMs, ms);
        totalVoteMs += ms;
      } else if (r.body?.error === "voting_closed") {
        votesClosed++;
      } else {
        votesErr++;
      }
    } catch(e) { votesErr++; }
  }, delay);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
