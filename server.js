"use strict";

const express = require("express");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { Pool } = require("pg");
const crypto = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure Render PostgreSQL.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable"
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validPlayerId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_profiles (
      player_id UUID PRIMARY KEY,
      games_played INTEGER NOT NULL DEFAULT 0,
      aggression DOUBLE PRECISION NOT NULL DEFAULT 0.15,
      queen_early DOUBLE PRECISION NOT NULL DEFAULT 0,
      king_exposure DOUBLE PRECISION NOT NULL DEFAULT 0,
      capture_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_moves INTEGER NOT NULL DEFAULT 0,
      profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chess_games (
      id BIGSERIAL PRIMARY KEY,
      player_id UUID NOT NULL REFERENCES player_profiles(player_id)
        ON DELETE CASCADE,
      pgn TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '*',
      move_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS chess_games_player_created_idx
    ON chess_games(player_id, created_at DESC)
  `);
}

async function ensureProfile(playerId) {
  await pool.query(
    `INSERT INTO player_profiles (player_id)
     VALUES ($1)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
}

async function getProfile(playerId) {
  await ensureProfile(playerId);

  const { rows } = await pool.query(
    `SELECT player_id, games_played, aggression, queen_early,
            king_exposure, capture_rate, total_moves,
            profile_json, updated_at
     FROM player_profiles
     WHERE player_id = $1`,
    [playerId]
  );

  return rows[0];
}

function runEngine({ fen, depth, timeMs, profile }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, "engine-worker.js"),
      {
        workerData: {
          fen,
          depth,
          timeMs,
          profile
        }
      }
    );

    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      worker.terminate();
      reject(new Error("Engine request timed out"));
    }, Math.max(14000, timeMs + 2500));

    worker.once("message", message => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();

      if (message.ok) resolve(message.result);
      else reject(new Error(message.error || "Engine error"));
    });

    worker.once("error", error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      reject(error);
    });

    worker.once("exit", code => {
      if (finished || code === 0) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error("Engine worker exited unexpectedly"));
    });
  });
}

app.get("/health", (req, res) => {
  res.json({
    name: "OANI Ω Chess",
    status: "alive",
    engine: "OANI Independent Search Engine",
    version: "1.0.0"
  });
});

app.get("/ready", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready", database: "connected" });
  } catch {
    res.status(503).json({
      status: "not_ready",
      database: "unavailable"
    });
  }
});

app.get("/api/profile/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;

    if (!validPlayerId(playerId)) {
      return res.status(400).json({ error: "Invalid player ID" });
    }

    const profile = await getProfile(playerId);
    res.json({ profile });
  } catch (error) {
    console.error("Profile read:", error.message);
    res.status(500).json({ error: "Could not load profile" });
  }
});

app.post("/api/observe", async (req, res) => {
  const {
    playerId,
    piece,
    capture,
    check,
    queenMove,
    kingExposed
  } = req.body || {};

  if (!validPlayerId(playerId)) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  const validPieces = ["p", "n", "b", "r", "q", "k"];

  if (!validPieces.includes(piece)) {
    return res.status(400).json({ error: "Invalid move data" });
  }

  try {
    await ensureProfile(playerId);

    const old = await getProfile(playerId);
    const nextMoves = old.total_moves + 1;

    const blend = (previous, sample) =>
      previous * 0.85 + sample * 0.15;

    const aggression = blend(
      old.aggression,
      check ? 1 : capture ? 0.65 : 0.15
    );

    const queenEarly = blend(
      old.queen_early,
      queenMove && nextMoves <= 12 ? 1 : 0
    );

    const kingExposure = blend(
      old.king_exposure,
      kingExposed ? 1 : 0
    );

    const captureRate = blend(
      old.capture_rate,
      capture ? 1 : 0
    );

    await pool.query(
      `UPDATE player_profiles
       SET aggression = $2,
           queen_early = $3,
           king_exposure = $4,
           capture_rate = $5,
           total_moves = total_moves + 1,
           updated_at = NOW()
       WHERE player_id = $1`,
      [
        playerId,
        aggression,
        queenEarly,
        kingExposure,
        captureRate
      ]
    );

    res.json({
      saved: true,
      profile: await getProfile(playerId)
    });
  } catch (error) {
    console.error("Observe:", error.message);
    res.status(500).json({ error: "Could not update opponent profile" });
  }
});

app.post("/api/engine", async (req, res) => {
  const { fen, playerId } = req.body || {};

  if (typeof fen !== "string" || fen.length > 200) {
    return res.status(400).json({ error: "Invalid FEN" });
  }

  if (!validPlayerId(playerId)) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  try {
    const profile = await getProfile(playerId);

    const depth = clamp(req.body.depth, 1, 9, 5);
    const timeMs = clamp(req.body.timeMs, 500, 12000, 3000);

    const result = await runEngine({
      fen,
      depth,
      timeMs,
      profile
    });

    res.json({
      engine: "OANI Ω",
      result,
      opponentProfile: {
        gamesPlayed: profile.games_played,
        aggression: profile.aggression,
        queenEarly: profile.queen_early,
        kingExposure: profile.king_exposure,
        captureRate: profile.capture_rate
      }
    });
  } catch (error) {
    console.error("Engine:", error.message);
    res.status(500).json({ error: "Engine search failed" });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { fen, playerId } = req.body || {};

  if (typeof fen !== "string" || fen.length > 200) {
    return res.status(400).json({ error: "Invalid FEN" });
  }

  if (!validPlayerId(playerId)) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  try {
    const profile = await getProfile(playerId);

    const result = await runEngine({
      fen,
      depth: clamp(req.body.depth, 1, 9, 6),
      timeMs: clamp(req.body.timeMs, 500, 12000, 5000),
      profile: {}
    });

    res.json({
      engine: "OANI Ω Analysis",
      result,
      profileGames: profile.games_played
    });
  } catch (error) {
    console.error("Analysis:", error.message);
    res.status(500).json({ error: "Analysis failed" });
  }
});

app.post("/api/games", async (req, res) => {
  const { playerId, pgn, result, moveCount } = req.body || {};

  if (!validPlayerId(playerId)) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  if (typeof pgn !== "string" || pgn.length < 2 || pgn.length > 100000) {
    return res.status(400).json({ error: "Invalid PGN" });
  }

  const safeResult = ["1-0", "0-1", "1/2-1/2", "*"].includes(result)
    ? result
    : "*";

  try {
    await ensureProfile(playerId);

    const saved = await pool.query(
      `INSERT INTO chess_games
       (player_id, pgn, result, move_count)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [
        playerId,
        pgn,
        safeResult,
        clamp(moveCount, 0, 1000, 0)
      ]
    );

    await pool.query(
      `UPDATE player_profiles
       SET games_played = games_played + 1,
           updated_at = NOW()
       WHERE player_id = $1`,
      [playerId]
    );

    res.json({
      saved: true,
      game: saved.rows[0]
    });
  } catch (error) {
    console.error("Game save:", error.message);
    res.status(500).json({ error: "Could not save game" });
  }
});

app.get("/api/games/:playerId", async (req, res) => {
  const { playerId } = req.params;

  if (!validPlayerId(playerId)) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, pgn, result, move_count, created_at
       FROM chess_games
       WHERE player_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [playerId]
    );

    res.json({ games: rows });
  } catch (error) {
    console.error("Game history:", error.message);
    res.status(500).json({ error: "Could not load games" });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

async function start() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`OANI Ω Chess running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
