
/**
 * OANI Ω Chess Engine
 * File: src/core/transposition-table.js
 *
 * Independent transposition table.
 * No external chess engine dependency.
 */

export const TT_EXACT = 0;
export const TT_LOWER = 1;
export const TT_UPPER = 2;

const MATE_SCORE = 30000;
const MATE_THRESHOLD = 29000;

function cloneMove(move) {
    if (!move) return null;

    return {
        from: move.from,
        to: move.to,
        promotion: move.promotion || undefined
    };
}

function scoreToTT(score, ply) {
    if (score >= MATE_THRESHOLD) {
        return score + ply;
    }

    if (score <= -MATE_THRESHOLD) {
        return score - ply;
    }

    return score;
}

function scoreFromTT(score, ply) {
    if (score >= MATE_THRESHOLD) {
        return score - ply;
    }

    if (score <= -MATE_THRESHOLD) {
        return score + ply;
    }

    return score;
}

export class TranspositionTable {
    constructor(options = {}) {
        this.maxEntries = options.maxEntries || 150000;

        this.table = new Map();

        this.generation = 0;
        this.hits = 0;
        this.misses = 0;
        this.stores = 0;
        this.replacements = 0;
    }

    /**
     * Begin a new search generation.
     */
    newGeneration() {
        this.generation++;

        if (this.generation > 1000000000) {
            this.generation = 1;
        }
    }

    /**
     * Retrieve a previously analyzed position.
     */
    probe(key, ply = 0) {
        const entry = this.table.get(key);

        if (!entry) {
            this.misses++;
            return null;
        }

        this.hits++;

        return {
            depth: entry.depth,
            score: scoreFromTT(entry.score, ply),
            flag: entry.flag,
            move: cloneMove(entry.move),
            generation: entry.generation
        };
    }

    /**
     * Save a search result.
     *
     * flag:
     * TT_EXACT = exact score
     * TT_LOWER = lower bound
     * TT_UPPER = upper bound
     */
    store({
        key,
        depth,
        score,
        flag,
        move,
        ply = 0
    }) {
        if (typeof key !== "string" || !key) {
            return false;
        }

        if (!Number.isFinite(depth) ||
            !Number.isFinite(score)) {
            return false;
        }

        if (![TT_EXACT, TT_LOWER, TT_UPPER].includes(flag)) {
            return false;
        }

        const old = this.table.get(key);

        const newEntry = {
            depth,
            score: scoreToTT(score, ply),
            flag,
            move: cloneMove(move),
            generation: this.generation
        };

        if (old) {
            const sameGeneration =
                old.generation === this.generation;

            const shouldReplace =
                depth > old.depth ||
                flag === TT_EXACT ||
                !sameGeneration;

            if (!shouldReplace) {
                return false;
            }

            this.replacements++;
            this.table.set(key, newEntry);

            return true;
        }

        if (this.table.size >= this.maxEntries) {
            this.evictEntries();
        }

        this.table.set(key, newEntry);
        this.stores++;

        return true;
    }

    /**
     * Remove older or shallow entries.
     * Keeps the table within its configured memory limit.
     */
    evictEntries() {
        const targetSize = Math.floor(
            this.maxEntries * 0.85
        );

        const entries = Array.from(this.table.entries());

        entries.sort((a, b) => {
            const A = a[1];
            const B = b[1];

            const ageA =
                this.generation - A.generation;

            const ageB =
                this.generation - B.generation;

            const qualityA =
                A.depth * 2 - ageA * 3;

            const qualityB =
                B.depth * 2 - ageB * 3;

            return qualityA - qualityB;
        });

        const removeCount =
            this.table.size - targetSize;

        for (let i = 0; i < removeCount; i++) {
            this.table.delete(entries[i][0]);
        }
    }

    /**
     * Get the stored best move for move ordering.
     */
    getBestMove(key) {
        const entry = this.table.get(key);

        return entry
            ? cloneMove(entry.move)
            : null;
    }

    /**
     * Remove all stored positions.
     */
    clear() {
        this.table.clear();

        this.hits = 0;
        this.misses = 0;
        this.stores = 0;
        this.replacements = 0;

        this.generation = 0;
    }

    /**
     * Return engine memory statistics.
     */
    getStats() {
        return {
            entries: this.table.size,
            maximumEntries: this.maxEntries,
            generation: this.generation,

            hits: this.hits,
            misses: this.misses,
            stores: this.stores,
            replacements: this.replacements,

            hitRate: this.hits + this.misses === 0
                ? 0
                : this.hits /
                  (this.hits + this.misses)
        };
    }
}

export default TranspositionTable;
