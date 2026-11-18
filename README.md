# Letterboxd Roulette

A party game: everyone joins on their phone with their Letterboxd username, the app pools
everyone's recent reviews, and each round shows one review. Guess **which film** (+1) and
**who wrote it** (+1, with 2+ players). Your own reviews are in the pool too, so you might not recognise them!

```
npm start        # prints a localhost URL and a Wi-Fi URL
```

1. On your phone (same Wi-Fi as the computer running this), open the Wi-Fi URL it prints.
2. Enter your Letterboxd username → **Host a new game**. You get a 4-letter code + QR code.
3. Friends scan the QR / open the link, enter their username, and join.
4. Pick 10/20/30 rounds and start. 60s per round; it reveals early once everyone locks in.

Solo mode (no lobby) is at `/solo`. No dependencies, Node 18+.

**Notes**
- Letterboxd's HTML pages are behind Cloudflare (403), so this reads each user's public RSS
  feed: roughly their last 50 diary entries, so it uses *recent* written reviews only.
- Game state lives in memory; restarting the server ends any games in progress.
- If phones can't connect, check macOS isn't blocking incoming connections for `node`
  (System Settings → Network → Firewall). To play with people not on your Wi-Fi, expose the
  port with a tunnel such as `cloudflared tunnel --url http://localhost:3456`.
