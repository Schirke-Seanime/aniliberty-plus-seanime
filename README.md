<p align="center">
  <img src="src/icon.png" alt="AniLiberty+" width="96">
</p>

<h1 align="center">AniLiberty+ for Seanime</h1>

<p align="center">
  <a href="https://anilibria.top">AniLibria / AniLiberty</a> extensions for <a href="https://github.com/5rahim/seanime">Seanime</a>:
  online streaming in 1080p and a torrent provider with a working <b>Smart search</b>.<br>
  Russian dubs, with the right season picked automatically.
</p>

---

## Installation

The repository has two independent extensions, install either or both.
In Seanime, open **Extensions** → **Add extension** and paste the manifest URL.

| Extension | Where it shows up | Manifest URL |
|---|---|---|
| **AniLiberty+ Online** | *Online streaming* tab | `https://raw.githubusercontent.com/Schirke/aniliberty-plus-seanime/main/online/manifest.json` |
| **AniLiberty+** | *Torrent streaming* tab | `https://raw.githubusercontent.com/Schirke/aniliberty-plus-seanime/main/src/manifest.json` |

- **Online streaming:** open an anime, go to *Online streaming* and pick **AniLiberty+ Online** as the provider.
- **Torrents:** when picking a torrent, select **AniLiberty+** and turn **Smart search** on. If you also have the
  original **AniLiberty** extension installed, disable it, otherwise every torrent shows up twice when
  "Search across providers" is on.

Updates arrive through Seanime's regular extension updates.

## Online streaming

**AniLiberty+ Online** plays AniLiberty's own HLS streams, so there's nothing to download and no waiting for peers.

- **1080p, 720p and 480p** for every episode.
- **New episodes right away.** An episode appears on the site before AniLiberty updates the torrent,
  so on ongoing shows the online stream is often a few days ahead of the torrent provider.
- **No ads in the stream.** All segments come from AniLiberty's CDN and add up to exactly the episode length.
- **The right season.** Same MAL ID matching as the torrent provider (see below).

### How matching works

Seanime searches the provider twice (romaji and English title), then picks the result whose title is closest
to the anime. It has no minimum similarity: whatever is in the list, something gets played. So the provider
only returns releases that really are the anime you opened:

1. A release with the same MAL ID as the AniList entry, if there is one. It is the only result.
2. Otherwise, releases without any MAL ID whose title equals or starts with one of the anime's titles.
   Releases with a *different* MAL ID are never offered: that's another show or another season.
3. Otherwise nothing, and Seanime reports that the anime wasn't found, instead of playing something unrelated.

If you search by hand (Seanime's manual match), the provider searches for exactly what you typed and returns everything it finds.

AniList numbers the episodes of every entry from 1, while AniLiberty sometimes continues the numbering in a
second part (*Uma Musume: Cinderella Gray Part 2* has episodes 14–23). Such releases are renumbered from 1.
A prologue numbered 0 is kept as episode 0.

### Testing

The full Seanime flow (two searches, picking the result, the episode list, the stream) against the live API,
including downloading the playlist and the first video segment:

| Case | Result |
|---|---|
| *Frieren*, episode 5 | found, 1080p/720p/480p, stream loads |
| *Dr. Stone: Science Future Part 3*, episode 2 | only that season |
| *The Apothecary Diaries* | found through the romaji title |
| *Uma Musume: Cinderella Gray Part 2* (episodes 14–23) | renumbered 1–10, episode 1 loads |
| *Wistoria Season 2* (has an episode 0) | episode 1 is the right episode |
| Ongoing show, episode 12 already on the site but not in the torrent | stream loads |
| Title that isn't on AniLiberty | nothing found (before the fix, an unrelated show was picked) |
| Season that isn't on AniLiberty while other seasons are | nothing found, no other season offered |
| Entry without a MAL ID (*Bocchi the Rock!*) | found by title |
| Manual search "dr stone" | all 7 Dr. Stone releases |

## Torrent provider

### Why this exists

This is a rewrite of [vsecoder/AniLiberty-Seanime](https://github.com/vsecoder/AniLiberty-Seanime),
the only AniLiberty provider for Seanime. The original has several problems that make it hard to use:

- **Smart search doesn't work.** `canSmartSearch` is `false` and `smartSearch()` returns an empty list.
- **Seasons get mixed together.** Search returns every torrent of every release the text query
  matches. Searching "Dr. Stone" gives 17 torrents across all 7 seasons, and nothing tells you which is which.
- **Some titles are never found.** AniLiberty's search barely matches English titles:
  "The Apothecary Diaries" returns 0 results, while "Kusuriya no Hitorigoto" finds it.
  The original sends a single query, so such shows look like they aren't on AniLiberty at all.
- **`getTorrentInfoHash` is missing**, although Seanime's provider interface requires it.
- **`getLatest` always returns nothing.**

These fixes were also submitted upstream as
[vsecoder/AniLiberty-Seanime#1](https://github.com/vsecoder/AniLiberty-Seanime/pull/1).
The original author is currently unavailable, so the fixed version lives here.

### What's different

#### Exact season matching by MAL ID

Every AniLiberty release carries its MyAnimeList ID, and so does every AniList entry in Seanime.
Smart search picks the release whose MAL ID matches the anime you're watching, so you only get
torrents for that exact season: *Dr. Stone: Science Future Part 3* no longer drags in *Stone Wars*
or *New World*. These results are marked as confirmed.

Releases without a MAL ID fall back to matching by title, year and episode count. Those results
are not marked as confirmed. A release with a *different* MAL ID is never used as a fallback: if the
season you're watching isn't on AniLiberty, you get nothing rather than torrents of another season.

#### Several title variants

To find a release in the first place, the provider searches up to five variants of the title:

1. the refined query, if you typed one
2. the romaji title
3. the English title
4. the base title without the season (`Dr. Stone: Science Future Part 3` → `Dr. Stone`)
5. synonyms

The broad base-title query finds the whole franchise; the MAL ID then narrows it down to the right season.

#### Episode filtering

AniLiberty often splits a season into several torrents. For example, *Dr. Stone* season 1 has
`1-13`, `14-24` and a full `1-24` batch. When you open episode 20, you get only the torrents that
contain episode 20: `14-24` and `1-24`.

On ongoing shows the torrent can lag behind the site: episode 12 is already out, but the torrent
still covers `1-11`. In that case the provider returns nothing rather than a torrent that doesn't contain
the episode, and Seanime keeps checking again until AniLiberty updates the torrent.

Resolution and batch filters are supported as well. If one of them would leave nothing, the provider
shows the unfiltered list instead of an empty screen.

#### Readable torrent names

The episode range, source, quality and codec are shown in the name:

```
Dr. Stone [14-24][WEBRip 1080p x264/AVC]
Dr. Stone: Science Future Part 3 [1-13][WEB-DL 1080p x265/HEVC][hardsub]
```

#### Smaller fixes

- Movies and OVAs (AniLiberty describes them as `Фильм`) are no longer marked as batches.
- Manual search still returns everything it finds, but the release matching the current anime comes first.
- `getTorrentInfoHash` is implemented, and `getLatest` returns the torrents of the latest releases.
- The best torrent of each release (highest resolution, then most seeders) is marked as the best release.
- Any network or API error results in an empty list instead of a failed search.

### Testing

Checked against the live AniLiberty API:

| Case | Result |
|---|---|
| *Dr. Stone* season 1, episode 20 | `1-24` and `14-24` only, `1-13` filtered out |
| *Dr. Stone: Science Future Part 3* | only that season, no other seasons mixed in |
| *The Apothecary Diaries* | found (the original returned 0 results) |
| *Frieren*, 1080p filter | 2 torrents |
| *Dr. Stone: Ryusui* (movie) | not a batch, episode 1 |
| Entry without a MAL ID (*Bocchi the Rock!*) | found by title, marked unconfirmed |
| Ongoing show, episode not in the torrent yet (`1-11`, episode 12 requested) | empty list, Seanime retries later |
| Season that isn't on AniLiberty while other seasons are | empty list, no other season offered |
| Title that isn't on AniLiberty | empty list, no errors |
| Manual search "Dr. STONE" | all 17 torrents, the current season first |

It has also been used in Seanime with torrent streaming on a number of titles.

## Limitations

AniLiberty doesn't dub every show. If a title isn't on [anilibria.top](https://anilibria.top),
neither extension can find it. That's not a matching bug, the release simply doesn't exist.
For torrents, turn on **Search across providers** so that other sources, such as Nyaa, fill in;
for online streaming, switch to another provider.

## Credits

- [vsecoder](https://github.com/vsecoder) for the original
  [AniLiberty-Seanime](https://github.com/vsecoder/AniLiberty-Seanime) extension and the icon
- [AniLibria / AniLiberty](https://anilibria.top) for the dubs and the public API
- [5rahim](https://github.com/5rahim) for [Seanime](https://github.com/5rahim/seanime)

## License

[MIT](LICENSE)
