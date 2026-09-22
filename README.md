# AI Subtitles for Stremio

> Translates English subtitles into 54 languages with a language model — reading the
> dialogue as one continuous passage rather than line by line, and returning it on the
> original timings. Free to run. Everyone uses their own Gemini API key.

---

Subtitle lines are cut by screen timing, not by sentence. One sentence is often split
across three lines. A single line on its own often means nothing. This is why line-by-line
machine translation is so hard to follow.

This addon works differently. It sends the model a long stretch of dialogue at once. The
lines before and after it are included as context, but are not translated. The model reads
the whole passage first. Only then does it spread the translation back across the same
numbered lines, in the target language's word order.

**Timings never move.** The file is checked before it is written. If any line has moved,
the process stops. You never get subtitles that are out of sync.

---

## Install

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Guy89a/stremio-hebrew-subs)

Press the button. You need to fill in two fields:

- **Blueprint Name** — this field is empty and required. Any name works.
- `GEMINI_API_KEY` — a free key from [Google AI Studio](https://aistudio.google.com/apikey).

Everything else is set for you, including a `SECRET` that is created automatically.

When the deploy finishes, your install address is your service address plus the language
you want:

```
https://<your-service>.onrender.com/heb/manifest.json     Hebrew
https://<your-service>.onrender.com/spa/manifest.json     Spanish
https://<your-service>.onrender.com/jpn/manifest.json     Japanese
```

In Stremio: **Addons** → paste the full address into the search box → **Install**.
Open an episode. Wait about a minute the first time. Then pick the language in the subtitle
menu.

> On Android there is no "Add addon" button — paste the address into the search field
> itself and the addon appears. Installing in the desktop app with the same account syncs
> it to your phone and TV.

**Stuck?** [`GUIDE.html`](GUIDE.html) is a step-by-step guide. It covers common problems
and how to run the addon on your own computer. It is written in Hebrew.

---

## Languages

You can install as many languages as you like at the same time. Each one appears in Stremio
as its own addon. `TARGET_LANG` sets the default for your server, but you do not need to
deploy again to use another language. Just put its code in the address.

<details>
<summary><b>All 54 codes</b> — click to expand</summary>

| Code | Language | Native |
|---|---|---|
| `heb` | Hebrew | עברית |
| `ara` | Arabic | العربية |
| `fas` | Persian | فارسی |
| `urd` | Urdu | اردو |
| `spa` | Spanish | Español |
| `por` | Portuguese | Português |
| `fre` | French | Français |
| `ita` | Italian | Italiano |
| `ger` | German | Deutsch |
| `dut` | Dutch | Nederlands |
| `pol` | Polish | Polski |
| `cze` | Czech | Čeština |
| `slo` | Slovak | Slovenčina |
| `slv` | Slovenian | Slovenščina |
| `hrv` | Croatian | Hrvatski |
| `srp` | Serbian | Српски |
| `bul` | Bulgarian | Български |
| `rus` | Russian | Русский |
| `ukr` | Ukrainian | Українська |
| `rum` | Romanian | Română |
| `hun` | Hungarian | Magyar |
| `gre` | Greek | Ελληνικά |
| `tur` | Turkish | Türkçe |
| `swe` | Swedish | Svenska |
| `nor` | Norwegian | Norsk |
| `dan` | Danish | Dansk |
| `fin` | Finnish | Suomi |
| `ice` | Icelandic | Íslenska |
| `est` | Estonian | Eesti |
| `lav` | Latvian | Latviešu |
| `lit` | Lithuanian | Lietuvių |
| `chi` | Chinese (Simplified) | 简体中文 |
| `jpn` | Japanese | 日本語 |
| `kor` | Korean | 한국어 |
| `tha` | Thai | ไทย |
| `vie` | Vietnamese | Tiếng Việt |
| `ind` | Indonesian | Bahasa Indonesia |
| `may` | Malay | Bahasa Melayu |
| `tgl` | Filipino | Filipino |
| `hin` | Hindi | हिन्दी |
| `ben` | Bengali | বাংলা |
| `tam` | Tamil | தமிழ் |
| `tel` | Telugu | తెలుగు |
| `mal` | Malayalam | മലയാളം |
| `swa` | Swahili | Kiswahili |
| `alb` | Albanian | Shqip |
| `mac` | Macedonian | Македонски |
| `geo` | Georgian | ქართული |
| `arm` | Armenian | Հայերեն |
| `aze` | Azerbaijani | Azərbaycan |
| `kaz` | Kazakh | Қазақша |
| `cat` | Catalan | Català |
| `glg` | Galician | Galego |
| `baq` | Basque | Euskara |

</details>

The instructions sent to the model are not written by hand for each language. They are
built from four facts about it:

- which script to write in
- which direction it reads
- whether you must choose a gender when you address someone
- whether it has both a familiar and a polite "you"

So adding a language is one row in `src/languages.js`. It is not new code. A code that is
not in the table still works, with neutral settings.

For many languages the table also holds the actual forms, because showing them works better
than describing them: `אתה / את / אתם / אתן` for Hebrew, `tu / vous` for French,
`du / Sie` for German, `сказал / сказала` for Russian. These go straight into the prompt.

**One thing to be clear about.** The model is good at common languages. The rarer the
language, the weaker it gets, and the mistakes can be hard to spot if you do not read it.
The addon will return a valid file in any language. The quality is not something this
project can promise. If you are the first person to try a language here, watch one episode
before you recommend it to anyone.

---

## What it does beyond translating

| | |
|---|---|
| **Context** | Chunks of 80 lines, with 12 neighbouring lines on each side as read-only context |
| **Direction** | Lines in a right-to-left language are wrapped in explicit RTL marks, so a full stop cannot jump to the start of the sentence |
| **Gender** | Dedicated guidance to decide who is being addressed and stay consistent, plus an optional evidence track in a language that marks it |
| **Speakers** | Detects an SDH track automatically and extracts who says each line — and from that, who is being addressed |
| **Cleanup** | Sound descriptions ("door creaks", "siren") are removed, and cues that were only a description disappear from the file |
| **Resilience** | Retries with growing backoff, automatic fallback to a second model, and bisection of chunks the content filter blocks |
| **Foreign dialogue** | With a reference track, lines the English skipped entirely are folded back in and translated from it |

---

## Cost and time

**Money: none.** Render's free tier and Gemini's free tier.

**Time: about a minute for a first episode.** Measured on a real one: 709 lines, 8 chunks,
51 seconds. Translation starts when you open the episode, not when you press Play, so you
wait less than that. After the first time the file is saved and loads at once for everyone
in the house.

It can take a few minutes if Google limits the rate (error 429) or the model is busy (503).
The addon waits and tries again by itself. The log shows what is happening.

Two settings change the time. Speaker names from an SDH track add about **8%**, and they
work on their own. `REFERENCE_LANG` adds about **a third**. Start without a reference track.
Add one only if gender is still wrong too often.

On Render's free plan the service sleeps after 15 minutes. You can keep it awake by calling
`/health` every few minutes from a free cron service. But **do not do this 24 hours a day**.
The free plan gives 750 hours a month, and a long month is 744 hours. If you go over, the
service stops until the next month. `*/10 0-3,6-23 * * *` gives 22 hours a day, with room
to spare.

---

## Configuration

Environment variables. All optional except the key.

| Field | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Your key. Empty means public mode, where each visitor configures their own on the front page |
| `SECRET` | generated | Encrypts a user's key into their personal install address. **Do not change after deploying** |
| `TARGET_LANG` | `heb` | Default target language. Any code from the table |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Comma-separated list allowed; the first that answers wins |
| `GEMINI_FALLBACK` | — | An extra model to fall back to when the first is overloaded |
| `CHUNK_SIZE` | `80` | Lines per request. Larger gives better context, but is blocked more often |
| `CONCURRENCY` | `1` | Requests at the same time. **Do not raise it.** This is what uses up the per-minute quota |
| `MIN_SPLIT` | `2` | How far to keep splitting a blocked chunk. Lower leaves less English, but is slower |
| `REFERENCE_LANG` | — | A second track in a language that marks gender, used as evidence |
| `FILL_FOREIGN_GAPS` | `1` | Fold in lines the English track skipped. Requires `REFERENCE_LANG` |
| `KEEP_SOUND_CUES` | — | `1` to keep sound descriptions instead of removing them |
| `MAX_SOURCES` | `2` | English sources translated per episode. `1` halves quota use |
| `RATE_LIMIT_PER_DAY` | `40` | New episodes per day per caller |
| `RATE_LIMIT_TOTAL` | `200` | Daily ceiling for the whole service |
| `MAX_JOBS` | `3` | Translations running at once |
| `MAX_SUBTITLE_BYTES` | `2000000` | Largest source file accepted |

---

## Running it locally

You do not need the cloud. On Windows: double-click `INSTALL.bat`, then `START.bat`.
The trade-off is that the computer has to stay on while you watch.

On any other system:

```bash
GEMINI_API_KEY=... node src/boot.js
```

And to convert a single SRT file without Stremio at all:

```bash
GEMINI_API_KEY=... node src/cli.js episode.en.srt
```

---

## Tests

```bash
npm test
```

Six test suites. They run without the network and without using any quota:

- parsing and timings
- the cloud path and key encryption
- text direction and foreign-script filtering
- reference-track alignment and speaker detection
- security — each check matches a real hole that was closed, so it cannot come back unnoticed
- languages — the table, direction, and keeping each language's cache and signature apart

---

## Privacy and security

Your key stays in your own server's environment variables. It appears in no address. It is
never written to the log or to disk.

Every subtitle link the server creates is signed. Nobody can change the source address
inside it to make the server download something else and translate it with your quota.
Private and internal addresses are refused. Downloads have a size limit, and so do
compressed files. There is a daily limit for each caller, and a second limit for the whole
service. The page that asks for a key is only served by a public server that needs it.

In public mode each user brings their own key. That key is encrypted inside their personal
install address. Someone who gets the address cannot read the key out of it, but they can
use it. So treat that address like a password.

The English subtitles come from the public OpenSubtitles addon, the same one Stremio comes
with. This addon does not host or share any subtitles of its own.

---

AGPL-3.0-or-later — see [`LICENSE`](LICENSE)
