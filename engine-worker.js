"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { Chess } = require("chess.js");

const LIMIT_MS = Math.max(500, Math.min(workerData.timeMs || 3000, 12000));
const MAX_DEPTH = Math.max(1, Math.min(workerData.depth || 5, 9));
const profile = workerData.profile || {};

const started = Date.now();
let nodes = 0;
let stopped = false;

const TT = new Map();
const TT_LIMIT = 180000;

const PIECE_VALUE = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 900,
  k: 20000
};

const FILES = "abcdefgh";

function checkTime() {
  if ((nodes & 1023) !== 0) return;

  if (Date.now() - started > LIMIT_MS) {
    stopped = true;
    throw new Error("SEARCH_TIMEOUT");
  }
}

function positionKey(game) {
  return game.fen().split(" ").slice(0, 4).join(" ");
}

function centerBonus(file, rank) {
  const f = Math.abs(3.5 - file);
  const r = Math.abs(3.5 - rank);
  return Math.round(14 - (f + r) * 3);
}

function evaluateWhite(game) {
  const board = game.board();
  let score = 0;
  let phase = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  const pawns = { w: [], b: [] };

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;

      const sign = p.color === "w" ? 1 : -1;
      const type = p.type;
      const advancement = p.color === "w" ? 6 - r : r - 1;
      let positional = 0;

      if (type === "p") {
        pawns[p.color].push({ file: f, rank: r });
        positional += advancement * 7;
        positional += centerBonus(f, r) * 0.25;
      }

      if (type === "n") {
        positional += centerBonus(f, r) * 2.2;
        phase += 1;
      }

      if (type === "b") {
        positional += centerBonus(f, r) * 1.5;
        phase += 1;
        if (p.color === "w") whiteBishops++;
        else blackBishops++;
      }

      if (type === "r") {
        positional += advancement > 3 ? 12 : 0;
        phase += 2;
      }

      if (type === "q") {
        positional += centerBonus(f, r) * 0.4;
        phase += 4;
      }

      if (type === "k") {
        positional += phase < 7
          ? centerBonus(f, r) * 1.5
          : -centerBonus(f, r) * 1.2;
      }

      score += sign * (PIECE_VALUE[type] + positional);
    }
  }

  if (whiteBishops >= 2) score += 28;
  if (blackBishops >= 2) score -= 28;

  for (const color of ["w", "b"]) {
    const sign = color === "w" ? 1 : -1;
    const list = pawns[color];

    const fileCounts = new Array(8).fill(0);
    for (const pawn of list) fileCounts[pawn.file]++;

    for (let f = 0; f < 8; f++) {
      if (fileCounts[f] > 1) score -= sign * 13 * (fileCounts[f] - 1);

      if (
        fileCounts[f] > 0 &&
        (f === 0 || fileCounts[f - 1] === 0) &&
        (f === 7 || fileCounts[f + 1] === 0)
      ) {
        score -= sign * 11;
      }
    }

    for (const pawn of list) {
      const enemy = color === "w" ? pawns.b : pawns.w;
      const blocked = enemy.some(e =>
        Math.abs(e.file - pawn.file) <= 1 &&
        (color === "w" ? e.rank < pawn.rank : e.rank > pawn.rank)
      );

      if (!blocked) {
        score += sign * Math.max(0, 5 - Math.abs(3.5 - pawn.file)) * 8;
      }
    }
  }

  return score;
}

function evaluate(game) {
  const whiteScore = evaluateWhite(game);
  return game.turn() === "w" ? whiteScore : -whiteScore;
}

function isCapture(move) {
  return Boolean(move.captured) || move.flags.includes("e");
}

function moveOrderScore(move, ttMove) {
  let score = 0;

  const uci = move.from + move.to + (move.promotion || "");

  if (uci === ttMove) score += 100000;

  if (isCapture(move)) {
    score += 10000 +
      (PIECE_VALUE[move.captured] || 0) * 10 -
      (PIECE_VALUE[move.piece] || 0);
  }

  if (move.promotion) score += 9000;
  return score;
}

function orderedMoves(game, ttMove) {
  return game.moves({ verbose: true }).sort(
    (a, b) => moveOrderScore(b, ttMove) - moveOrderScore(a, ttMove)
  );
}

function quiescence(game, alpha, beta, ply) {
  nodes++;
  checkTime();

  if (game.isCheckmate()) return -30000 + ply;
  if (game.isDraw()) return 0;

  const inCheck = game.isCheck();
  let stand = inCheck ? -Infinity : evaluate(game);

  if (!inCheck) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }

  let moves = game.moves({ verbose: true });

  if (!inCheck) {
    moves = moves.filter(m => isCapture(m) || m.promotion);
  }

  moves.sort((a, b) => moveOrderScore(b) - moveOrderScore(a));

  for (const move of moves) {
    game.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
    });

    let score;

    try {
      score = -quiescence(game, -beta, -alpha, ply + 1);
    } finally {
      game.undo();
    }

    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

function negamax(game, depth, alpha, beta, ply) {
  nodes++;
  checkTime();

  if (game.isCheckmate()) return -30000 + ply;
  if (game.isDraw()) return 0;

  if (depth <= 0) {
    return quiescence(game, alpha, beta, ply);
  }

  const key = positionKey(game);
  const originalAlpha = alpha;
  const cached = TT.get(key);

  let ttMove = "";

  if (cached) {
    ttMove = cached.move || "";

    if (cached.depth >= depth) {
      if (cached.flag === "exact") return cached.score;
      if (cached.flag === "lower") alpha = Math.max(alpha, cached.score);
      if (cached.flag === "upper") beta = Math.min(beta, cached.score);
      if (alpha >= beta) return cached.score;
    }
  }

  const moves = orderedMoves(game, ttMove);

  if (!moves.length) {
    return game.isCheck() ? -30000 + ply : 0;
  }

  let bestScore = -Infinity;
  let bestMove = "";

  for (const move of moves) {
    const uci = move.from + move.to + (move.promotion || "");

    game.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
    });

    let score;

    try {
      score = -negamax(game, depth - 1, -beta, -alpha, ply + 1);
    } finally {
      game.undo();
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = uci;
    }

    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }

  const flag = bestScore <= originalAlpha
    ? "upper"
    : bestScore >= beta
      ? "lower"
      : "exact";

  if (TT.size >= TT_LIMIT) TT.clear();

  TT.set(key, {
    depth,
    score: bestScore,
    flag,
    move: bestMove
  });

  return bestScore;
}

function parseUci(uci) {
  if (!uci || uci.length < 4) return null;

  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4] } : {})
  };
}

function profileBias(game, move) {
  const aggression = Number(profile.aggression || 0);
  const queenEarly = Number(profile.queenEarly || 0);
  const kingExposure = Number(profile.kingExposure || 0);

  let bonus = 0;

  game.move({
    from: move.from,
    to: move.to,
    promotion: move.promotion
  });

  try {
    if (game.isCheck()) {
      bonus += Math.min(22, 8 + aggression * 10 + kingExposure * 12);
    }

    if (move.promotion) bonus += 15;

    if (
      queenEarly > 0.35 &&
      (move.piece === "n" || move.piece === "b")
    ) {
      bonus += queenEarly * 5;
    }
  } finally {
    game.undo();
  }

  return bonus;
}

function reconstructPV(game, maxLength = 12) {
  const clone = new Chess(game.fen());
  const pv = [];

  for (let i = 0; i < maxLength; i++) {
    const item = TT.get(positionKey(clone));
    if (!item || !item.move) break;

    const move = parseUci(item.move);
    if (!move) break;

    try {
      const result = clone.move(move);
      if (!result) break;
      pv.push(result.san);
    } catch {
      break;
    }
  }

  return pv;
}

function run() {
  const game = new Chess(workerData.fen);
  const rootMoves = game.moves({ verbose: true });

  if (!rootMoves.length) {
    return {
      bestMove: null,
      score: game.isCheckmate() ? -30000 : 0,
      depth: 0,
      nodes,
      pv: []
    };
  }

  let bestMove = rootMoves[0];
  let bestScore = -Infinity;
  let completedDepth = 0;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    let iterationBest = null;
    let iterationScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;

    const sorted = orderedMoves(game, "");

    for (const move of sorted) {
      game.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion
      });

      let score;

      try {
        score = -negamax(game, depth - 1, -beta, -alpha, 1);
      } finally {
        game.undo();
      }

      score += profileBias(game, move);

      if (score > iterationScore) {
        iterationScore = score;
        iterationBest = move;
      }

      alpha = Math.max(alpha, score);
    }

    if (stopped) break;

    if (iterationBest) {
      bestMove = iterationBest;
      bestScore = iterationScore;
      completedDepth = depth;
    }
  }

  const best = {
    from: bestMove.from,
    to: bestMove.to,
    ...(bestMove.promotion ? { promotion: bestMove.promotion } : {})
  };

  game.move(best);
  const pv = [bestMove.san, ...reconstructPV(game, 11)];

  return {
    bestMove: best,
    score: bestScore,
    depth: completedDepth,
    nodes,
    elapsedMs: Date.now() - started,
    pv
  };
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error.message === "SEARCH_TIMEOUT"
      ? "Search time limit reached"
      : "Engine search failed"
  });
}
