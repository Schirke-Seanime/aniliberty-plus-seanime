/// <reference path="./anime-torrent-provider.d.ts" />

// AniLiberty (anilibria.top) provider для Seanime.
//
// Отличия от исходного расширения:
//   1. Работает smartSearch — релиз определяется по MAL ID из AniList,
//      поэтому сезоны больше не смешиваются в одну кучу.
//   2. Название ищется несколькими вариантами (romaji / english / синонимы /
//      базовое название без сезона) — у AniLibria плохо проиндексированы
//      английские названия, из-за чего часть тайтлов «не находилась».
//   3. Раздачи фильтруются по номеру серии: у AniLibria сезон часто разбит
//      на несколько торрентов (например 1-13 и 14-24).

const API = "https://aniliberty.top/api/v1"

const SEARCH_INCLUDE = "id,alias,name,mal,year,episodes_total"
const TORRENT_INCLUDE = [
    "id", "hash", "size", "label", "magnet", "seeders", "leechers",
    "completed_times", "created_at", "description", "is_hardsub",
    "quality", "codec", "type",
].join(",")

// Сколько релизов максимум разворачиваем в торренты при ручном поиске.
const MAX_RELEASES = 12
// Сколько вариантов названия пробуем при smart search.
const MAX_QUERIES = 5

interface LibName {
    main?: string
    english?: string
    alternative?: string
}

interface LibRelease {
    id: number
    alias?: string
    name?: LibName
    mal?: { id?: number }
    year?: number
    episodes_total?: number
}

interface LibTorrent {
    id: number
    hash?: string
    size?: number
    label?: string
    magnet?: string
    seeders?: number
    leechers?: number
    completed_times?: number
    created_at?: string
    description?: string
    is_hardsub?: boolean
    quality?: { description?: string }
    codec?: { description?: string }
    type?: { value?: string }
}

interface EpisodeRange {
    from: number
    to: number
    known: boolean
}

class Provider {

    private headers = { "Accept": "application/json" }

    async getSettings(): Promise<AnimeProviderSettings> {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
        }
    }

    // --- Точки входа --------------------------------------------------------

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const queries = opts.query
                ? [opts.query]
                : this.buildQueries(opts.media, "")

            const releases = await this.searchReleases(queries)
            if (releases.length === 0) return []

            // Ручной поиск ничего не отбрасывает, но релиз, совпавший по MAL ID,
            // поднимается наверх — иначе нужный сезон тонет среди остальных.
            const malId = opts.media ? opts.media.idMal : undefined
            const ordered = releases.slice()
            ordered.sort((a, b) => this.malRank(a, malId) - this.malRank(b, malId))

            const torrents = await this.collectTorrents(
                ordered.slice(0, MAX_RELEASES),
                malId,
            )
            return this.sortTorrents(torrents)
        } catch (e) {
            console.error("[AniLiberty] search:", e)
            return []
        }
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const media = opts.media
            const queries = this.buildQueries(media, opts.query)
            const releases = await this.searchReleases(queries)

            if (releases.length === 0) {
                console.log("[AniLiberty] релизы не найдены по запросам:", queries.join(" | "))
                return []
            }

            const picked = this.pickReleases(releases, media)
            if (picked.releases.length === 0) {
                console.log("[AniLiberty] ни один релиз не сопоставлен с тайтлом")
                return []
            }

            console.log(
                `[AniLiberty] сопоставлено релизов: ${picked.releases.length}` +
                ` (${picked.confirmed ? "точно по MAL ID" : "по названию"})`,
            )

            const malId = picked.confirmed && media ? media.idMal : undefined
            let torrents = await this.collectTorrents(picked.releases, malId)

            torrents = this.applyFilters(torrents, opts)
            return this.sortTorrents(torrents)
        } catch (e) {
            console.error("[AniLiberty] smartSearch:", e)
            return []
        }
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const releases = await this.getJson<LibRelease[]>(
                `${API}/anime/releases/latest?limit=8&include=${SEARCH_INCLUDE}`,
            )
            if (!releases || !Array.isArray(releases)) return []
            return this.sortTorrents(await this.collectTorrents(releases, undefined))
        } catch (e) {
            console.error("[AniLiberty] getLatest:", e)
            return []
        }
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    // --- Подбор релиза ------------------------------------------------------

    // Варианты запроса в порядке убывания надёжности. AniLibria ищет по
    // romaji и русскому названию заметно лучше, чем по английскому AniList
    // (например «Apothecary Diaries» не находится, а «Kusuriya no Hitorigoto» —
    // находится), поэтому одного варианта недостаточно.
    private buildQueries(media: Media | undefined, query: string): string[] {
        const out: string[] = []
        const push = (s: string | undefined) => {
            if (!s) return
            const trimmed = s.trim()
            if (!trimmed) return
            const key = this.normalize(trimmed)
            if (!key) return
            for (const existing of out) {
                if (this.normalize(existing) === key) return
            }
            out.push(trimmed)
        }

        push(query)
        if (media) {
            push(media.romajiTitle)
            push(media.englishTitle)
            push(this.baseTitle(media.romajiTitle))
            push(this.baseTitle(media.englishTitle))
            const syn = media.synonyms || []
            for (let i = 0; i < syn.length && i < 2; i++) push(syn[i])
        }

        return out.slice(0, MAX_QUERIES)
    }

    // «Dr. Stone: Science Future Part 3» -> «Dr. Stone».
    // Широкий запрос повышает шанс найти релиз, а нужный сезон потом
    // отбирается точно по MAL ID.
    private baseTitle(title: string | undefined): string {
        if (!title) return ""
        let s = title
        s = s.replace(/\s*[:\-–—]\s*(season|part|cour)\s*\d+.*$/i, "")
        s = s.replace(/\s+(season|part|cour)\s*\d+.*$/i, "")
        s = s.replace(/\s+\d+(st|nd|rd|th)\s+season.*$/i, "")
        s = s.replace(/\s*:.*$/, "")
        s = s.trim()
        return this.normalize(s) === this.normalize(title) ? "" : s
    }

    private async searchReleases(queries: string[]): Promise<LibRelease[]> {
        if (queries.length === 0) return []

        const responses = await Promise.all(queries.map(q =>
            this.getJson<LibRelease[]>(
                `${API}/app/search/releases?query=${encodeURIComponent(q)}&include=${SEARCH_INCLUDE}`,
            ),
        ))

        const seen: { [id: number]: boolean } = {}
        const out: LibRelease[] = []
        for (const list of responses) {
            if (!list || !Array.isArray(list)) continue
            for (const r of list) {
                if (!r || typeof r.id !== "number" || seen[r.id]) continue
                seen[r.id] = true
                out.push(r)
            }
        }
        return out
    }

    private pickReleases(
        releases: LibRelease[],
        media: Media | undefined,
    ): { releases: LibRelease[]; confirmed: boolean } {

        // Основной путь: точное совпадение по MAL ID. Именно это разделяет
        // сезоны одного тайтла, которые текстовый поиск свалить в кучу.
        if (media && media.idMal) {
            const exact = releases.filter(r => r.mal && r.mal.id === media.idMal)
            if (exact.length > 0) return { releases: exact, confirmed: true }
        }

        // Запасной путь: у релиза может не быть MAL ID. Тогда сравниваем
        // название, год и число серий.
        const scored: { r: LibRelease; s: number }[] = []
        for (const r of releases) {
            const s = this.score(r, media)
            if (s > 0) scored.push({ r: r, s: s })
        }
        scored.sort((a, b) => b.s - a.s)
        return { releases: scored.slice(0, 3).map(x => x.r), confirmed: false }
    }

    private score(release: LibRelease, media: Media | undefined): number {
        if (!media) return 0

        const candidates: string[] = []
        if (release.name) {
            if (release.name.english) candidates.push(release.name.english)
            if (release.name.main) candidates.push(release.name.main)
            if (release.name.alternative) candidates.push(release.name.alternative)
        }

        const targets: string[] = []
        if (media.romajiTitle) targets.push(media.romajiTitle)
        if (media.englishTitle) targets.push(media.englishTitle)
        for (const s of (media.synonyms || [])) targets.push(s)

        let best = 0
        for (const c of candidates) {
            const nc = this.normalize(c)
            if (!nc) continue
            for (const t of targets) {
                const nt = this.normalize(t)
                if (!nt) continue
                if (nc === nt) best = Math.max(best, 100)
                else if (nc.indexOf(nt) === 0 || nt.indexOf(nc) === 0) best = Math.max(best, 60)
                else if (nc.indexOf(nt) >= 0 || nt.indexOf(nc) >= 0) best = Math.max(best, 40)
            }
        }
        if (best === 0) return 0

        if (media.startDate && release.year === media.startDate.year) best += 20
        if (media.episodeCount && release.episodes_total === media.episodeCount) best += 15
        return best
    }

    private malRank(release: LibRelease, malId: number | undefined): number {
        if (!malId) return 1
        return (release.mal && release.mal.id === malId) ? 0 : 1
    }

    // --- Торренты -----------------------------------------------------------

    private async collectTorrents(
        releases: LibRelease[],
        confirmedMalId: number | undefined,
    ): Promise<AnimeTorrent[]> {

        const lists = await Promise.all(releases.map(async (r) => {
            const data = await this.getJson<LibTorrent[]>(
                `${API}/anime/torrents/release/${r.id}?include=${TORRENT_INCLUDE}`,
            )
            if (!data || !Array.isArray(data)) return [] as AnimeTorrent[]

            const confirmed = !!(confirmedMalId && r.mal && r.mal.id === confirmedMalId)
            const bestId = this.bestTorrentId(data)

            const mapped: AnimeTorrent[] = []
            for (const t of data) {
                const at = this.toAnimeTorrent(t, r, confirmed, t.id === bestId)
                if (at) mapped.push(at)
            }
            return mapped
        }))

        // Один и тот же торрент может прийти из разных релизов — дедуплицируем
        // по info hash.
        const seen: { [hash: string]: boolean } = {}
        const out: AnimeTorrent[] = []
        for (const list of lists) {
            for (const t of list) {
                const key = (t.infoHash || t.magnetLink || t.name).toLowerCase()
                if (seen[key]) continue
                seen[key] = true
                out.push(t)
            }
        }
        return out
    }

    private bestTorrentId(torrents: LibTorrent[]): number {
        let bestId = -1
        let bestScore = -1
        for (const t of torrents) {
            const res = this.resolutionValue(t.quality ? t.quality.description : "")
            const score = res * 1000 + (t.seeders || 0)
            if (score > bestScore) {
                bestScore = score
                bestId = t.id
            }
        }
        return bestId
    }

    private toAnimeTorrent(
        t: LibTorrent,
        release: LibRelease,
        confirmed: boolean,
        isBest: boolean,
    ): AnimeTorrent | null {

        if (!t.magnet && !t.hash) return null

        const title = (release.name && (release.name.english || release.name.main)) || t.label || "?"
        const quality = (t.quality && t.quality.description) || ""
        const codec = (t.codec && t.codec.description) || ""
        const kind = (t.type && t.type.value) || ""
        const desc = (t.description || "").trim()

        const range = this.parseRange(desc, release.episodes_total)
        // Односерийные релизы (фильмы, OVA) приходят с описанием вроде «Фильм» —
        // диапазон не разобрать, но батчем это называть неверно.
        const single = release.episodes_total === 1
        const isBatch = single ? false : (!range.known || range.to > range.from)

        const tags: string[] = []
        if (desc) tags.push(desc)
        const specs = [kind, quality, codec].filter(x => !!x).join(" ")
        if (specs) tags.push(specs)
        if (t.is_hardsub) tags.push("hardsub")

        const name = tags.length > 0
            ? `${title} [${tags.join("][")}]`
            : title

        const size = t.size || 0

        return {
            name: name,
            date: t.created_at || "",
            size: size,
            formattedSize: this.bytesToHuman(size),
            seeders: typeof t.seeders === "number" ? t.seeders : -1,
            leechers: typeof t.leechers === "number" ? t.leechers : -1,
            downloadCount: t.completed_times || 0,
            link: release.alias
                ? `https://anilibria.top/anime/releases/release/${release.alias}`
                : "",
            downloadUrl: `${API}/anime/torrents/${t.id}/file`,
            magnetLink: t.magnet || "",
            infoHash: t.hash || "",
            resolution: quality,
            releaseGroup: "AniLiberty",
            isBatch: isBatch,
            episodeNumber: isBatch ? -1 : (single ? 1 : range.from),
            isBestRelease: isBest,
            confirmed: confirmed,
        }
    }

    // --- Фильтры ------------------------------------------------------------

    private applyFilters(
        torrents: AnimeTorrent[],
        opts: AnimeSmartSearchOptions,
    ): AnimeTorrent[] {

        let out = torrents

        if (opts.resolution) {
            const want = this.resolutionValue(opts.resolution)
            if (want > 0) {
                const filtered = out.filter(t => this.resolutionValue(t.resolution || "") === want)
                // Если по запрошенному качеству ничего нет, лучше показать всё,
                // чем пустой список.
                if (filtered.length > 0) out = filtered
            }
        }

        if (opts.batch) {
            const filtered = out.filter(t => t.isBatch === true)
            if (filtered.length > 0) out = filtered
        }

        if (opts.episodeNumber && opts.episodeNumber > 0) {
            const ep = opts.episodeNumber
            const filtered = out.filter(t => this.coversEpisode(t, ep))
            if (filtered.length > 0) out = filtered
        }

        return out
    }

    // Диапазон серий зашит в name как первый тег — разбираем его обратно,
    // чтобы не тащить лишнее поле через интерфейс AnimeTorrent.
    private coversEpisode(t: AnimeTorrent, ep: number): boolean {
        const m = t.name.match(/\[(\d{1,4})\s*[-–—~]\s*(\d{1,4})\]/)
        if (m) {
            const from = parseInt(m[1], 10)
            const to = parseInt(m[2], 10)
            return ep >= from && ep <= to
        }
        if (t.episodeNumber && t.episodeNumber > 0) return t.episodeNumber === ep
        // Диапазон неизвестен (фильм, спешл, нестандартное описание) —
        // не прячем раздачу.
        return true
    }

    // --- Утилиты ------------------------------------------------------------

    private parseRange(desc: string, total: number | undefined): EpisodeRange {
        const d = (desc || "").trim()

        let m = d.match(/(\d{1,4})\s*[-–—~]\s*(\d{1,4})/)
        if (m) {
            const from = parseInt(m[1], 10)
            const to = parseInt(m[2], 10)
            if (to >= from) return { from: from, to: to, known: true }
        }

        m = d.match(/^(\d{1,4})$/)
        if (m) {
            const n = parseInt(m[1], 10)
            return { from: n, to: n, known: true }
        }

        return { from: 1, to: (total && total > 0) ? total : 9999, known: false }
    }

    private resolutionValue(res: string): number {
        if (!res) return 0
        const m = res.match(/(\d{3,4})/)
        return m ? parseInt(m[1], 10) : 0
    }

    private normalize(s: string | undefined): string {
        if (!s) return ""
        return s
            .toLowerCase()
            .replace(/[^a-zа-яё0-9]+/gi, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    private sortTorrents(torrents: AnimeTorrent[]): AnimeTorrent[] {
        const out = torrents.slice()
        out.sort((a, b) => {
            if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1
            return (b.seeders || 0) - (a.seeders || 0)
        })
        return out
    }

    private bytesToHuman(bytes: number): string {
        if (!bytes) return ""
        const k = 1024
        const units = ["B", "KiB", "MiB", "GiB", "TiB"]
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
        return (bytes / Math.pow(k, i)).toFixed(2) + " " + units[i]
    }

    private async getJson<T>(url: string): Promise<T | null> {
        try {
            const res = await fetch(url, { headers: this.headers })
            if (!res.ok) {
                console.log(`[AniLiberty] HTTP ${res.status}: ${url}`)
                return null
            }
            return await res.json() as T
        } catch (e) {
            console.log(`[AniLiberty] запрос не удался: ${url}`, e)
            return null
        }
    }
}
