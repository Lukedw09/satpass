# SatPass

[SatPass](https://satpass.lukedw09.workers.dev/) is a satellite pass predictor. It shows when the ISS, Tiangong, Hubble, and other bright satellites cross your sky, and which of those passes you can see with the naked eye.

**Use it at [satpass.lukedw09.workers.dev](https://satpass.lukedw09.workers.dev/).**

![SatPass, with a pass list, sky chart, and live ground track](docs/screenshot.png)

It opens on Killearn Lakes, north Tallahassee, Florida (30.588° N, 84.243° W, 60 m). Every clock time on the page is Eastern Time (EST or EDT), even if you move the observer somewhere else.

## Set your location

Under **Observer**, type a name, latitude, longitude, and elevation in meters. Or click **Use my location** and let the browser fill them in (it will ask permission). **Killearn Lakes** restores the default spot. This browser remembers your place, your filters, and your satellite list.

## Add and remove satellites

The list starts with the ISS, Tiangong, Hubble, Envisat, and two bright SL-16 rocket bodies. A tick includes that satellite in the search. Untick a row to skip it. **✕** removes it.

To add one, type a name or a NORAD catalog number — `HST` or `25544` — and press **Add**. Suggestions come from the space stations and the bright-satellite list. A NORAD number picks one object for sure. If a name matches several satellites, SatPass adds the first and tells you; enter the number to choose another.

## Filters

These sit under **Search**:

- **Days** — how far ahead to look, from 1 to 10. The default is 7.
- **Min max-el °** — hide passes that never get this high. `10` (the default) keeps passes that reach at least 10° above the horizon. `0` keeps anything that rises at all. `40` keeps only high ones.
- **Sun below °** — how far below the horizon the Sun must be before the sky counts as dark. The default is −6° (about civil twilight). The allowed range is −18° (a darker sky) to 0° (sunset level).
- **Visible (naked-eye) passes only** — on by default. Turn it off to list daylight and shadowed passes too. Each of those rows says why it fails: daylight, in shadow, or too low.

The line above the table looks like `5 shown · 5 visible · next 7 days · times EST`. If nothing is listed, lower the minimum elevation, add days, or turn visible-only off.

## Reading a pass

Click a row. That pass is drawn on the sky chart, and **Live now** follows that satellite.

| Column | Meaning |
|---|---|
| Date | The day of the pass. **NOW** means it is above the horizon at this moment. |
| Satellite | Which object. The dot color matches the list on the left. |
| Rise | When it crosses your horizon, and the compass point to look toward (N, NE, WSW, and so on). |
| Max | The highest point: the time, the elevation in degrees, and the compass point. 0° is the horizon and 90° is straight overhead. A 20° pass is low; 60° is high in the sky. |
| Set | When it drops below the horizon again, and the compass point in that direction. |
| Dur | How long it stays above the horizon, such as `10m 13s`. |
| Visible window | The stretch you can see, or the reason you cannot. |

A visible window looks like `★ 7:29:15 PM – 7:32:01 PM`, plus the best point of that stretch, such as `max 23° NW`. Rise, max, and set describe the whole pass from horizon to horizon. The starred times are the shorter part worth going outside for.

## The sky chart

The chart looks straight up. The center is overhead, the rim is the horizon, and the rings mark 30° and 60°. North is at the top. Stand facing the rise direction from the table, then follow the arc.

The line uses the legend under the chart:

- **Gold — sunlit & dark sky (visible).** This is the part to watch.
- **Blue — sunlit, not visible.** The satellite is in sunlight, and your sky is still bright or it is below 10°.
- **Dim — in Earth's shadow.** Earth is between the Sun and the satellite, so it goes dark.

A circle is rise, a diamond is the highest point, and a square is set. During a pass that is happening now, a green dot marks where it is. Under the chart: duration, distance at the highest point, and the Sun's altitude then. If the satellite enters shadow before it sets, the note says it fades into Earth's shadow.

**Live now**, next to the chart, updates every second with direction, elevation, distance, height, speed, and whether the satellite is sunlit. The map draws its ground track from 45 minutes ago through 90 minutes ahead, the region where it is above the horizon, your location, and the night side of Earth.

## What "visible" means

A moment is visible only when all three are true:

1. **You are in the dark.** The Sun is below the **Sun below** number (default −6°).
2. **The satellite is sunlit**, clear of Earth's shadow.
3. **It is at least 10° up**, high enough to clear a lot of rooftops and trees.

That 10° floor stays put. **Min max-el** only decides which passes get a row. The visible window still opens at 10°.

## Spotting it

Be outside about a minute before the visible window opens, and look toward the rise compass direction, just above the horizon. You are looking for a steady, non-blinking moving dot that slides along the path on the chart. Keep following that arc. When the gold line ends and the track turns dim, the satellite is entering Earth's shadow and fades from sight.

The ISS is usually an obvious bright light. Hubble and the rocket bodies are much fainter, and a pass can meet the visible test and still be hard to see.

## Where the data comes from, and how fresh it is

Orbital data comes from [CelesTrak](https://celestrak.org/). The header says which copy the page is using:

- **CelesTrak live** — downloaded just now.
- **CelesTrak (cached in this browser)** — that same download, reused for about 2 hours.
- **Offline: bundled TLE snapshot** — a copy saved with the site, used when CelesTrak cannot be reached and this browser has nothing newer.

Next to the source is the fetch time and an age, such as `just now` or `3.2 h ago`. That age turns orange after 3 days. Each satellite also shows its own element-set age, such as `TLE epoch 0.6 d old`, and that label turns orange after 5 days. Older elements drift, so an orange age is a reason to refresh before you count on a time.

**↻ Refresh TLEs** downloads a new copy. The button then waits 10 minutes, because CelesTrak asks people not to fetch too often.

## How the predictions work

CelesTrak publishes a short description of each orbit, called an element set. SatPass runs those numbers through SGP4, the standard orbit model, in your browser with [satellite.js](https://github.com/shashwatak/satellite-js). SGP4 gives the satellite's position at the time in question. From your latitude and longitude, that becomes a compass direction and an elevation. The Sun's position does the rest: it decides whether your sky is dark, and whether Earth is casting its shadow across the satellite. The pass list, the sky chart, and the live map are that same calculation drawn three ways.

## Accuracy and limits

A fresh element set is usually good to about a kilometer, which is close enough to find the pass by eye. The error grows as the set ages, which is what the age labels are for. The ISS reboosts its orbit, and a burn can move a pass by tens of seconds until CelesTrak publishes a new set.

There is no brightness or magnitude. "Visible" is geometry: dark sky, sunlit satellite, at least 10° up. Terrain is ignored, so a hill or a building can hide a low pass. Atmospheric refraction is ignored too; it lifts an object on the horizon by about half a degree and shifts rise or set by a few seconds. Times are always Eastern, whatever time zone you are standing in.

To run a copy yourself, open `index.html` in a browser. MIT License © 2026 Luke de Wet. Orbits from [CelesTrak](https://celestrak.org/). Predictions use [satellite.js](https://github.com/shashwatak/satellite-js) (MIT). Coastlines from [Natural Earth](https://www.naturalearthdata.com/).
