/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

// Online streaming from AniLiberty (AniLibria): HLS in 480p / 720p / 1080p.
// Episodes appear on the site before the torrents get updated, and there are
// no ads in the stream itself (the ad flags in the URLs only affect their
// own web player).

// Max title variants tried per search.
const MAX_QUERIES = 5;
// Title similarity a release without a matching MAL ID needs to be offered
// at all: the title equals or starts with one of the entry's titles.
const MIN_TITLE_SCORE = 60;
// Search results are reused for a while: Seanime calls search() twice in a row
// (romaji and English title) with the same media.
const CACHE_TTL_MS = 5 * 60 * 1000;

const SEARCH_INCLUDE = "id,alias,name,mal,year,episodes_total";
const SERVER = "AniLiberty";

class Provider {
  private api = "https://aniliberty.top/api/v1";
  private headers = {
    "accept": "application/json"
  };
  private cache: { [key: string]: { at: number; value: any } } = {};

  getSettings(): Settings {
    return {
      episodeServers: [SERVER],
      // AniLiberty only has Russian dubs, there is no sub/dub choice to make.
      supportsDub: false
    };
  }

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    const media = opts.media;

    // Manual mapping: the user typed the query, search for exactly that and show
    // everything found. Automatic matching always queries with the entry's own
    // romaji or English title.
    if (!media || !this.isAutoQuery(media, opts.query)) {
      const found = await this.searchReleases([opts.query]);
      return found.map(r => this.toSearchResult(r));
    }

    const releases = await this.searchReleases(this.buildQueries(media, ""));
    if (releases.length === 0) return [];

    // Seanime picks among the results by title similarity and has no minimum
    // threshold: whatever is in the list, something gets played. So only
    // releases that really are this entry may be returned.

    // Exact match by MAL ID.
    if (media.idMal) {
      const exact = releases.filter(r => r.mal && r.mal.id === media.idMal);
      if (exact.length > 0) return exact.map(r => this.toSearchResult(r));
    }

    // Fallback by title. A release with a different MAL ID is a different show
    // (e.g. another season of the same franchise), so when the entry has a MAL ID
    // only releases without one are considered.
    const pool = media.idMal ? releases.filter(r => !(r.mal && r.mal.id)) : releases;
    const scored: { r: any; s: number }[] = [];
    for (const r of pool) {
      const s = this.score(r, media);
      if (s >= MIN_TITLE_SCORE) scored.push({ r, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => this.toSearchResult(x.r));
  }

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
    const release = await this.getJson(`${this.api}/anime/releases/${encodeURIComponent(id)}`);
    if (!release || !Array.isArray(release.episodes)) return [];

    const episodes = release.episodes.filter((e: any) =>
      e && typeof e.ordinal === "number" && (e.hls_1080 || e.hls_720 || e.hls_480)
    );
    if (episodes.length === 0) return [];

    // AniList numbers every entry from 1, while AniLiberty sometimes continues
    // the numbering in a second part (episodes 14-23). Shift those back to 1.
    // Episode 0 (prologue) is kept as is.
    const min = Math.min(...episodes.map((e: any) => e.ordinal));
    const offset = min > 1 ? min - 1 : 0;

    const alias = release.alias || "";
    return episodes
      .map((e: any) => ({
        id: String(e.id),
        number: e.ordinal - offset,
        url: alias ? `https://anilibria.top/anime/releases/release/${alias}/episodes` : "",
        title: this.episodeTitle(e)
      }))
      .sort((a: EpisodeDetails, b: EpisodeDetails) => a.number - b.number);
  }

  async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
    // Stream URLs are fetched fresh rather than kept from findEpisodes, which
    // Seanime caches.
    const e = await this.getJson(`${this.api}/anime/releases/episodes/${encodeURIComponent(episode.id)}`);
    if (!e) throw new Error("AniLiberty: episode not found");

    const videoSources: VideoSource[] = [];
    const add = (url: string | null | undefined, quality: string) => {
      if (url) videoSources.push({ url, type: "m3u8", quality, subtitles: [] });
    };
    add(e.hls_1080, "1080p");
    add(e.hls_720, "720p");
    add(e.hls_480, "480p");

    if (videoSources.length === 0) throw new Error("AniLiberty: no streams for this episode");

    return {
      server: SERVER,
      // The CDN allows any origin and needs no special headers.
      headers: {},
      videoSources
    };
  }

  // -------------------------
  // Release search
  // -------------------------

  private toSearchResult(r: any): SearchResult {
    return {
      id: String(r.id),
      title: (r.name && (r.name.english || r.name.main)) || String(r.id),
      url: r.alias ? `https://anilibria.top/anime/releases/release/${r.alias}` : "",
      subOrDub: "dub"
    };
  }

  // Title variants, most reliable first. AniLiberty's search matches romaji
  // and Russian titles far better than English ones, so one query isn't enough.
  private buildQueries(media: Media | undefined, query: string): string[] {
    const out: string[] = [];
    const push = (s: string | undefined) => {
      if (!s) return;
      const trimmed = s.trim();
      const key = this.normalize(trimmed);
      if (!key) return;
      for (const existing of out) {
        if (this.normalize(existing) === key) return;
      }
      out.push(trimmed);
    };

    push(query);
    if (media) {
      push(media.romajiTitle);
      push(media.englishTitle);
      push(this.baseTitle(media.romajiTitle));
      push(this.baseTitle(media.englishTitle));
      const syn = media.synonyms || [];
      for (let i = 0; i < syn.length && i < 2; i++) push(syn[i]);
    }

    return out.slice(0, MAX_QUERIES);
  }

  // "Dr. Stone: Science Future Part 3" -> "Dr. Stone".
  // A broad query finds the franchise; the exact season is then picked by MAL ID.
  private baseTitle(title: string | undefined): string {
    if (!title) return "";
    let s = title;
    s = s.replace(/\s*[:\-–—]\s*(season|part|cour)\s*\d+.*$/i, "");
    s = s.replace(/\s+(season|part|cour)\s*\d+.*$/i, "");
    s = s.replace(/\s+\d+(st|nd|rd|th)\s+season.*$/i, "");
    s = s.replace(/\s*:.*$/, "");
    s = s.trim();
    return this.normalize(s) === this.normalize(title) ? "" : s;
  }

  private async searchReleases(queries: string[]): Promise<any[]> {
    const key = queries.map(q => this.normalize(q)).join("|");
    const hit = this.cache[key];
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const responses = await Promise.all(
      queries.map(q =>
        this.getJson(
          `${this.api}/app/search/releases` +
          `?query=${encodeURIComponent(q)}` +
          `&include=${SEARCH_INCLUDE}`
        )
      )
    );

    const seen: { [id: number]: boolean } = {};
    const out: any[] = [];
    for (const list of responses) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!r || typeof r.id !== "number" || seen[r.id]) continue;
        seen[r.id] = true;
        out.push(r);
      }
    }

    this.cache[key] = { at: Date.now(), value: out };
    return out;
  }

  private isAutoQuery(media: Media, query: string): boolean {
    const q = this.normalize(query);
    return !q || q === this.normalize(media.romajiTitle) || q === this.normalize(media.englishTitle);
  }

  private score(release: any, media: Media): number {
    const candidates: string[] = [];
    if (release.name) {
      if (release.name.english) candidates.push(release.name.english);
      if (release.name.main) candidates.push(release.name.main);
      if (release.name.alternative) candidates.push(release.name.alternative);
    }

    const targets: string[] = [];
    if (media.romajiTitle) targets.push(media.romajiTitle);
    if (media.englishTitle) targets.push(media.englishTitle);
    for (const s of media.synonyms || []) targets.push(s);

    let best = 0;
    for (const c of candidates) {
      const nc = this.normalize(c);
      if (!nc) continue;
      for (const t of targets) {
        const nt = this.normalize(t);
        if (!nt) continue;
        if (nc === nt) best = Math.max(best, 100);
        else if (nc.indexOf(nt) === 0 || nt.indexOf(nc) === 0) best = Math.max(best, 60);
        else if (nc.indexOf(nt) >= 0 || nt.indexOf(nc) >= 0) best = Math.max(best, 40);
      }
    }
    return best;
  }

  // -------------------------
  // Helpers
  // -------------------------

  private episodeTitle(e: any): string {
    if (e.name_english) return e.name_english;
    // Russian titles come wrapped in «guillemets».
    return (e.name || "").replace(/^[«"]+|[»"]+$/g, "").trim();
  }

  private normalize(s: string | undefined): string {
    if (!s) return "";
    return s
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async getJson(url: string): Promise<any> {
    try {
      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
