import crypto from "node:crypto";
import { scrapeUser } from "./scrape.js";

export const QUESTION_MS = 60_000;
// Each correct answer is worth up to MAX_POINTS if you lock in instantly, sliding down
// to MIN_POINTS at the buzzer. Wrong answers are worth 0.
const MAX_POINTS = 1000;
const MIN_POINTS = 500;
const MAX_PLAYERS = 12;
const ROOM_IDLE_MS = 60 * 60 * 1000;

const rooms = new Map();

const fail = (status, message) => Object.assign(new Error(message), { status });
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const filmKey = (r) => `${r.film.toLowerCase()}|${r.year}`;

function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion with 1/0
  let c;
  do c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
  while (rooms.has(c));
  return c;
}

export function getRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw fail(404, "Room not found. Check the code.");
  return room;
}

function requirePlayer(room, pid) {
  const p = room.players.get(pid);
  if (!p) throw fail(403, "You're not in this room");
  return p;
}

const requireHost = (room, pid) => {
  requirePlayer(room, pid);
  if (pid !== room.hostId) throw fail(403, "Only the host can do that");
};

// The host drives the game, but if the host's phone drops off anyone can keep it moving.
const canControl = (room, pid) => pid === room.hostId || !(room.players.get(room.hostId)?.conns > 0);

async function loadUser(username) {
  const u = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,40}$/.test(u)) throw fail(400, "Enter a valid Letterboxd username");
  return scrapeUser(u);
}

function addPlayer(room, data) {
  const p = {
    id: crypto.randomUUID(),
    username: data.username,
    displayName: data.displayName,
    reviews: data.reviews,
    score: 0,
    conns: 0,
  };
  room.players.set(p.id, p);
  return p;
}

export async function createRoom(username) {
  const data = await loadUser(username);
  const room = {
    code: newCode(),
    hostId: null,
    players: new Map(),
    phase: "lobby", // lobby | question | reveal | over
    totalRounds: 20,
    askPerson: false,
    rounds: [],
    idx: -1,
    answers: new Map(),
    timer: null,
    deadline: 0,
    clients: new Set(),
    lastActive: Date.now(),
  };
  room.hostId = addPlayer(room, data).id;
  rooms.set(room.code, room);
  return { code: room.code, playerId: room.hostId };
}

export async function joinRoom(code, username) {
  const room = getRoom(code);
  const data = await loadUser(username);
  // Same username again = the same person rejoining (new phone, cleared browser, etc.)
  const existing = [...room.players.values()].find((p) => p.username === data.username);
  if (existing) return { code: room.code, playerId: existing.id };
  if (room.phase !== "lobby") throw fail(409, "That game has already started");
  if (room.players.size >= MAX_PLAYERS) throw fail(409, "Room is full");
  const p = addPlayer(room, data);
  broadcast(room);
  return { code: room.code, playerId: p.id };
}

export function leave(room, pid) {
  requirePlayer(room, pid);
  if (room.phase !== "lobby" && room.phase !== "over") throw fail(409, "Can't leave mid-game");
  room.players.delete(pid);
  for (const c of room.clients) if (c.pid === pid) { c.res.end(); room.clients.delete(c); }
  if (!room.players.size) return destroy(room);
  if (pid === room.hostId) room.hostId = room.players.keys().next().value;
  broadcast(room);
}

export function settings(room, pid, { rounds }) {
  requireHost(room, pid);
  if (room.phase !== "lobby") throw fail(409, "Game already started");
  const n = parseInt(rounds, 10);
  if (Number.isFinite(n)) room.totalRounds = Math.max(5, Math.min(50, n));
  broadcast(room);
}

function buildRounds(room) {
  // Deal round-robin from each player's shuffled reviews so one prolific reviewer doesn't dominate.
  const decks = shuffle(
    [...room.players.values()]
      .map((p) => shuffle(p.reviews.map((r) => ({ ...r, authorId: p.id }))))
      .filter((d) => d.length)
  );
  const picked = [];
  while (picked.length < room.totalRounds && decks.some((d) => d.length))
    for (const d of decks) if (d.length && picked.length < room.totalRounds) picked.push(d.pop());
  shuffle(picked);

  const allFilms = new Map();
  for (const p of room.players.values())
    for (const r of p.reviews) allFilms.set(filmKey(r), `${r.film} (${r.year})`);

  return picked.map((r) => {
    const key = filmKey(r);
    const decoys = shuffle([...allFilms.keys()].filter((k) => k !== key)).slice(0, 3);
    return {
      review: r,
      filmKey: key,
      filmOptions: shuffle([key, ...decoys]).map((k) => ({ key: k, label: allFilms.get(k) })),
      masked: maskTitle(r),
      results: null,
    };
  });
}

// Black out the film title if the reviewer names it (skip very short titles like "Up" or "Us").
function maskTitle(r) {
  if (r.film.length <= 3) return r.paragraphs;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(r.film)}(?![\\p{L}\\p{N}])`, "giu");
  return r.paragraphs.map((p) => p.replace(re, "█████"));
}

export function start(room, pid) {
  requireHost(room, pid);
  if (room.phase !== "lobby") throw fail(409, "Game already started");
  if (![...room.players.values()].some((p) => p.reviews.length))
    throw fail(400, "Nobody here has any recent written reviews to play with");
  for (const p of room.players.values()) p.score = 0;
  // Everyone guesses every round, including their own reviews (you won't always recognise them).
  room.askPerson = room.players.size >= 2;
  room.rounds = buildRounds(room);
  room.idx = -1;
  nextRound(room);
}

const round = (room) => room.rounds[room.idx];

function nextRound(room) {
  clearTimeout(room.timer);
  if (room.idx + 1 >= room.rounds.length) {
    room.phase = "over";
    return broadcast(room);
  }
  room.idx++;
  room.answers = new Map();
  room.phase = "question";
  room.deadline = Date.now() + QUESTION_MS;
  room.timer = setTimeout(() => reveal(room), QUESTION_MS);
  broadcast(room);
}

function checkAllAnswered(room) {
  if (room.phase !== "question") return;
  const guessers = [...room.players.values()].filter((p) => p.conns > 0);
  if (guessers.length && guessers.every((p) => room.answers.has(p.id))) reveal(room);
}

export function answer(room, pid, { person, film }) {
  requirePlayer(room, pid);
  if (room.phase !== "question") throw fail(409, "Not accepting answers right now");
  if (room.answers.has(pid)) throw fail(409, "Already locked in");
  const r = round(room);
  if (!r.filmOptions.some((o) => o.key === film)) throw fail(400, "Pick a film");
  if (room.askPerson && !room.players.has(person)) throw fail(400, "Pick who wrote it");
  room.answers.set(pid, { person: room.askPerson ? person : null, film, at: Date.now() });
  broadcast(room);
  checkAllAnswered(room);
}

function reveal(room) {
  if (room.phase !== "question") return;
  clearTimeout(room.timer);
  const r = round(room);
  r.results = [];
  for (const [pid, a] of room.answers) {
    const p = room.players.get(pid);
    if (!p) continue;
    const filmRight = a.film === r.filmKey;
    const personRight = room.askPerson && a.person === r.review.authorId;
    const ms = Math.max(0, a.at - (room.deadline - QUESTION_MS));
    const speed = Math.max(0, 1 - ms / QUESTION_MS);
    const each = Math.round(MIN_POINTS + (MAX_POINTS - MIN_POINTS) * speed);
    const gained = each * (Number(filmRight) + Number(personRight));
    p.score += gained;
    r.results.push({ id: pid, person: a.person, film: a.film, filmRight, personRight, gained, ms });
  }
  room.phase = "reveal";
  broadcast(room);
}

export function revealNow(room, pid) {
  requirePlayer(room, pid);
  if (!canControl(room, pid)) throw fail(403, "Only the host can do that");
  reveal(room);
}

export function next(room, pid) {
  requirePlayer(room, pid);
  if (!canControl(room, pid)) throw fail(403, "Only the host can do that");
  if (room.phase !== "reveal") throw fail(409, "Nothing to advance");
  nextRound(room);
}

export function backToLobby(room, pid) {
  requireHost(room, pid);
  if (room.phase !== "over") throw fail(409, "Game isn't over");
  room.phase = "lobby";
  room.rounds = [];
  room.idx = -1;
  for (const p of room.players.values()) p.score = 0;
  broadcast(room);
}

export function publicState(room, pid) {
  const r = round(room);
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    score: p.score,
    reviewCount: p.reviews.length,
    connected: p.conns > 0,
    answered: room.phase === "question" && room.answers.has(p.id),
  }));
  const s = {
    code: room.code,
    phase: room.phase,
    you: pid,
    hostId: room.hostId,
    canControl: canControl(room, pid),
    totalRounds: room.totalRounds,
    roundCount: room.rounds.length,
    roundNumber: room.idx + 1,
    askPerson: room.askPerson,
    questionMs: QUESTION_MS,
    players,
  };
  if (r && (room.phase === "question" || room.phase === "reveal")) {
    const revealed = room.phase === "reveal";
    s.round = {
      paragraphs: revealed ? r.review.paragraphs : r.masked,
      spoilers: r.review.spoilers,
      filmOptions: r.filmOptions,
      yourAnswer: room.answers.get(pid) || null,
      remainingMs: Math.max(0, room.deadline - Date.now()),
    };
    if (revealed) {
      const rv = r.review;
      s.round.answer = {
        film: rv.film, year: rv.year, poster: rv.poster, link: rv.link,
        rating: rv.rating, liked: rv.liked, filmKey: r.filmKey, authorId: rv.authorId,
        results: r.results,
      };
    }
  }
  return s;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const c of room.clients) c.res.write(`data: ${JSON.stringify(publicState(room, c.pid))}\n\n`);
}

export function subscribe(room, pid, res) {
  const p = requirePlayer(room, pid);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const client = { pid, res };
  room.clients.add(client);
  p.conns++;
  broadcast(room);
  res.on("close", () => {
    if (!room.clients.delete(client)) return;
    p.conns = Math.max(0, p.conns - 1);
    checkAllAnswered(room);
    broadcast(room);
  });
}

function destroy(room) {
  clearTimeout(room.timer);
  for (const c of room.clients) c.res.end();
  rooms.delete(room.code);
}

// Keep SSE connections alive through phones/proxies, and clean up abandoned rooms.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients) c.res.write(": ping\n\n");
    if (!room.clients.size && Date.now() - room.lastActive > ROOM_IDLE_MS) destroy(room);
  }
}, 20_000).unref();
