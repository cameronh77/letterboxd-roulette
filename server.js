import http from "node:http";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scrapeUser } from "./scrape.js";
import * as game from "./game.js";

const PORT = process.env.PORT || 3456;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const lanUrls = () =>
  Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body ?? { ok: true }) : body);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10_000) reject(Object.assign(new Error("Body too large"), { status: 413 }));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
  });

const actions = {
  settings: game.settings,
  start: game.start,
  answer: game.answer,
  reveal: game.revealNow,
  next: game.next,
  lobby: game.backToLobby,
  leave: game.leave,
};

const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // ["api","rooms",CODE,action]
  try {
    if (url.pathname === "/api/info") return send(res, 200, { lanUrls: lanUrls() });

    // Solo mode
    if (url.pathname === "/api/reviews") {
      const users = (url.searchParams.get("users") || "")
        .split(/[\s,]+/).map((u) => u.trim().toLowerCase()).filter(Boolean);
      if (!users.length) return send(res, 400, { error: "Enter at least one username" });
      const results = await Promise.allSettled([...new Set(users)].map(scrapeUser));
      return send(res, 200, {
        users: results.filter((r) => r.status === "fulfilled").map((r) => r.value),
        errors: results.filter((r) => r.status === "rejected").map((r) => r.reason.message),
      });
    }

    if (parts[0] === "api" && parts[1] === "rooms") {
      if (parts.length === 2 && req.method === "POST") {
        const { username } = await readJson(req);
        return send(res, 200, await game.createRoom(username));
      }
      const [, , code, action] = parts;
      if (action === "join" && req.method === "POST") {
        const { username } = await readJson(req);
        return send(res, 200, await game.joinRoom(code, username));
      }
      const room = game.getRoom(code);
      if (action === "events") return game.subscribe(room, url.searchParams.get("pid"), res);
      if (action === "state") {
        const pid = url.searchParams.get("pid");
        if (!room.players.has(pid)) return send(res, 403, { error: "You're not in this room" });
        return send(res, 200, game.publicState(room, pid));
      }
      if (actions[action] && req.method === "POST") {
        const body = await readJson(req);
        await actions[action](room, body.pid, body);
        return send(res, 200);
      }
      return send(res, 404, { error: "Unknown action" });
    }

    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file === "solo") file = "solo.html";
    if (file.includes("..")) return send(res, 400, "bad path", "text/plain");
    const body = await readFile(path.join(PUBLIC, file));
    send(res, 200, body, TYPES[file.split(".").pop()] || "application/octet-stream");
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, "not found", "text/plain");
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Letterboxd Roulette → http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  on your Wi-Fi     → ${u}`);
});
