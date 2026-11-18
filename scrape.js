// Letterboxd blocks scraping of HTML pages (Cloudflare 403), but the public RSS feed
// is open and contains the user's most recent diary entries, including review text.
const cache = new Map(); // username -> { at, data }
const TTL = 10 * 60 * 1000;

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
   .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
   .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
   .replace(/&amp;/g, "&");

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
};

export async function scrapeUser(username) {
  const hit = cache.get(username);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const res = await fetch(`https://letterboxd.com/${encodeURIComponent(username)}/rss/`, {
    headers: { "User-Agent": "Mozilla/5.0 (letterboxd-roulette)" },
  });
  if (res.status === 404) throw Object.assign(new Error(`User "${username}" not found`), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`Letterboxd returned ${res.status} for "${username}"`), { status: 502 });
  const xml = await res.text();

  const channelTitle = decode(tag(xml.split("<item>")[0], "title"));
  const displayName = channelTitle.replace(/^Letterboxd - /, "") || username;

  const reviews = [];
  for (const item of xml.split("<item>").slice(1)) {
    if (!/letterboxd-review-/.test(tag(item, "guid"))) continue;
    const desc = tag(item, "description").replace(/^<!\[CDATA\[|\]\]>$/g, "");
    const poster = (desc.match(/<img src="([^"]+)"/) || [])[1] || null;
    const spoilers = /This review may contain spoilers/.test(desc);
    const paragraphs = [...desc.matchAll(/<p>([\s\S]*?)<\/p>/g)]
      .map((m) => m[1])
      .filter((p) => !/^<img/.test(p) && !/This review may contain spoilers/.test(p))
      .map((p) => decode(p.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")).trim())
      .filter(Boolean);
    if (!paragraphs.length) continue;
    const rating = parseFloat(tag(item, "letterboxd:memberRating"));
    reviews.push({
      username,
      displayName,
      film: decode(tag(item, "letterboxd:filmTitle")),
      year: tag(item, "letterboxd:filmYear"),
      rating: Number.isFinite(rating) ? rating : null,
      liked: tag(item, "letterboxd:memberLike") === "Yes",
      rewatch: tag(item, "letterboxd:rewatch") === "Yes",
      watchedDate: tag(item, "letterboxd:watchedDate"),
      link: tag(item, "link"),
      poster,
      spoilers,
      paragraphs,
    });
  }
  const data = { username, displayName, reviews };
  cache.set(username, { at: Date.now(), data });
  return data;
}

