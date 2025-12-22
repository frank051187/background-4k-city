const express = require("express");
const path = require("path");
const { Readable } = require("stream");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name} en .env`);
  return v;
}

const PER_PAGE_DEFAULT = 30;

// --------- SEARCHERS ----------
async function searchPexels(q, page, perPage) {
  const key = mustEnv("PEXELS_API_KEY");
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", q);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels error ${res.status}`);
  const data = await res.json();

  return (data.photos || []).map(p => ({
    id: String(p.id),
    source: "pexels",
    width: p.width,
    height: p.height,
    author: p.photographer || "",
    alt: p.alt || "",
    pageUrl: p.url,
    downloadUrl: p.src?.original,
    src: { preview: p.src?.large || p.src?.medium, original: p.src?.original }
  }));
}

async function searchUnsplash(q, page, perPage) {
  const key = mustEnv("UNSPLASH_ACCESS_KEY");
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", q);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
  if (!res.ok) throw new Error(`Unsplash error ${res.status}`);
  const data = await res.json();

  return (data.results || []).map(p => ({
    id: String(p.id),
    source: "unsplash",
    width: p.width,
    height: p.height,
    author: p.user?.name || p.user?.username || "",
    alt: p.alt_description || p.description || "",
    pageUrl: p.links?.html,
    downloadUrl: p.links?.download_location
      ? `${p.links.download_location}&client_id=${key}`
      : (p.links?.download || p.urls?.full),
    src: { preview: p.urls?.regular || p.urls?.small, original: p.urls?.full || p.urls?.raw }
  }));
}

async function searchPixabay(q, page, perPage) {
  const key = mustEnv("PIXABAY_API_KEY");
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", q);
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("safesearch", "true");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay error ${res.status}`);
  const data = await res.json();

  return (data.hits || []).map(p => ({
    id: String(p.id),
    source: "pixabay",
    width: p.imageWidth,
    height: p.imageHeight,
    author: p.user || "",
    alt: p.tags || "",
    pageUrl: p.pageURL,
    downloadUrl: p.largeImageURL || p.fullHDURL || p.webformatURL,
    src: { preview: p.webformatURL, original: p.largeImageURL || p.fullHDURL || p.webformatURL }
  }));
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.src?.preview || !it?.src?.original) continue;
    const k = `${it.source}|${it.id}|${it.src.original}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  out.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return out;
}

// --------- API SEARCH ----------
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const source = String(req.query.source || "pexels").toLowerCase();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(80, Math.max(10, parseInt(req.query.per_page || String(PER_PAGE_DEFAULT), 10)));

    if (!q) return res.status(400).json({ error: "Falta q" });

    let items = [];
    let errors = [];

    if (source === "pexels") items = await searchPexels(q, page, perPage);
    else if (source === "unsplash") items = await searchUnsplash(q, page, perPage);
    else if (source === "pixabay") items = await searchPixabay(q, page, perPage);
    else if (source === "all") {
      const results = await Promise.allSettled([
        searchPexels(q, page, perPage),
        searchUnsplash(q, page, perPage),
        searchPixabay(q, page, perPage),
      ]);
      for (const r of results) {
        if (r.status === "fulfilled") items.push(...r.value);
        else errors.push(r.reason?.message || "Fuente falló");
      }
    } else {
      return res.status(400).json({ error: "source inválido" });
    }

    items = dedupe(items);
    res.json({ items, page, perPage, errors });
  } catch (e) {
    res.status(500).json({ error: e.message || "Error del servidor" });
  }
});

// --------- API DOWNLOAD (directo) ----------
app.get("/api/download", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    const name = String(req.query.name || "imagen.jpg");

    if (!url.startsWith("http")) return res.status(400).send("URL inválida");

    const upstream = await fetch(url, { redirect: "follow" });
    if (!upstream.ok) return res.status(502).send(`No se pudo descargar. Status ${upstream.status}`);

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/"/g, "")}"`);

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.pipe(res);
  } catch (e) {
    res.status(500).send(e.message || "Error en descarga");
  }
});

// --------- START ----------
const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`✅ Servidor listo: http://localhost:${PORT}`);
});
