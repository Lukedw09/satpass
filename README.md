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
- **Brighter than mag** — leave it blank to keep every pass. Type a number such as `3` to keep only passes whose peak magnitude is brighter than that (a smaller number is brighter). A pass with no magnitude is left out while this filter is set.

The line above the table looks like `5 shown · 5 visible · next 7 days · times EST`. If a magnitude limit is set, it adds `brighter than 3`. If nothing is listed, lower the minimum elevation, add days, clear the magnitude box, or turn visible-only off.

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
| Mag | The brightest predicted magnitude during the visible stretch. Smaller numbers are brighter. `—` means SatPass has no standard magnitude for that object and will not guess. Click the heading to sort brightest first, click again for faintest first, and click **Date** to go back to time order. |
| Cloud | The forecast cloud cover for the hour nearest the highest point: a dot and a percent. Gold is clear (under 25%), half gold is partly cloudy (25–70%), and gray is cloudy (over 70%). Hover the cell for the low, mid, and high cloud. `no forecast` means that time is outside the 7-day forecast. If the forecast cannot be loaded, the column is left off the table. |
| Visible window | The stretch you can see, or the reason you cannot. |

A visible window looks like `★ 7:29:15 PM – 7:32:01 PM`, plus the best point of that stretch, such as `max 23° NW`. Rise, max, and set describe the whole pass from horizon to horizon. The starred times are the shorter part worth going outside for.

## Reminders

Every pass row, and the sky-chart detail under it, has a bell and an **Add to calendar** button. The bell asks for notification permission the first time you use it (or when you turn on the ISS option), then rings before the pass becomes visible. Choose **5, 10, or 15 minutes** under **Alerts**. **10** is the default. A gold bell means that pass is armed, and the card says how many alerts are set. **Notify me for all visible ISS passes** arms every visible ISS pass for you. The choice is remembered in this browser.

Alerts work while SatPass is open, or while it is installed and running. A closed tab does not ring. **Add to calendar** downloads an `.ics` file with the same lead time, so your phone can remind you anyway. On an iPhone, Safari shows browser alerts only after you add SatPass to your Home Screen and open it from there; until then, use the calendar file.

## The sky chart

The chart looks straight up. The center is overhead, the rim is the horizon, and the rings mark 30° and 60°. North is at the top. Stand facing the rise direction from the table, then follow the arc.

The line uses the legend under the chart:

- **Gold — sunlit & dark sky (visible).** This is the part to watch.
- **Blue — sunlit, not visible.** The satellite is in sunlight, and your sky is still bright or it is below 10°.
- **Dim — in Earth's shadow.** Earth is between the Sun and the satellite, so it goes dark.

A circle is rise, a diamond is the highest point, and a square is set. During a pass that is happening now, a green dot marks where it is. Move the pointer along the arc and the chart shows the magnitude at that spot, or `—` when that object has no standard magnitude. Under the chart: duration, peak magnitude, distance at the highest point, and the Sun's altitude then. If the satellite enters shadow before it sets, the note says it fades into Earth's shadow.

**Live now**, next to the chart, updates every second with direction, elevation, distance, height, speed, and whether the satellite is sunlit. The map draws its ground track from 45 minutes ago through 90 minutes ahead, the region where it is above the horizon, your location, and the night side of Earth.

## What "visible" means

A moment is visible only when all three are true:

1. **You are in the dark.** The Sun is below the **Sun below** number (default −6°).
2. **The satellite is sunlit**, clear of Earth's shadow.
3. **It is at least 10° up**, high enough to clear a lot of rooftops and trees.

That 10° floor stays put. **Min max-el** only decides which passes get a row. The visible window still opens at 10°.

## Spotting it

Be outside about a minute before the visible window opens, and look toward the rise compass direction, just above the horizon. You are looking for a steady, non-blinking moving dot that slides along the path on the chart. Keep following that arc. When the gold line ends and the track turns dim, the satellite is entering Earth's shadow and fades from sight.

The ISS is usually an obvious bright light. Hubble and the rocket bodies are much fainter, and a pass can meet the visible test and still be hard to see. The **Mag** column is there for that: it is an estimate, not a promise, and a tumbling rocket can be a magnitude or two off either way.

## Recent launches and Starlink trains

Under **Satellites**, **Recent launches** lists objects from CelesTrak's last-30-days group. Nothing in that list is included until you tick it.

A Starlink launch that is less than about 10 days old, and whose satellites are still close in mean motion, is one row: `Starlink train (Group 2026-242, launched Nov 14)`, with the number of satellites and how many minutes the string takes to pass. The prediction uses the lead satellite, the one at the front of the string. The group id is the international designator of the launch (year and launch number). When one of those trains has a visible pass in the search window, a gold banner above the table says when and which way to look, for example `Starlink train visible Tue 6:42 PM, look WNW`.

## Where the data comes from, and how fresh it is

Orbital data comes from [CelesTrak](https://celestrak.org/). The header says which copy the page is using:

- **CelesTrak live** — downloaded just now.
- **CelesTrak (cached in this browser)** — that same download, reused for about 2 hours.
- **Offline: bundled TLE snapshot** — a copy saved with the site, used when CelesTrak cannot be reached and this browser has nothing newer.

Next to the source is the fetch time and an age, such as `just now` or `3.2 h ago`. That age turns orange after 3 days. Each satellite also shows its own element-set age, such as `TLE epoch 0.6 d old`, and that label turns orange after 5 days. Older elements drift, so an orange age is a reason to refresh before you count on a time.

**↻ Refresh TLEs** downloads a new copy of the station list, the bright-satellite list, the last-30-days group, and the Starlink group. The button then waits 10 minutes, because CelesTrak asks people not to fetch too often. The same copy is kept in this browser for about 2 hours. Launch dates for the train list come from the CelesTrak catalog, on that same schedule.

Cloud cover comes from [Open-Meteo](https://open-meteo.com/) (no account). SatPass asks once when you change the observer, then reuses that forecast for about an hour. The request is the hourly total plus low, mid, and high cloud for 7 days in Eastern Time.

## How the predictions work

CelesTrak publishes a short description of each orbit, called an element set. SatPass runs those numbers through SGP4, the standard orbit model, in your browser with [satellite.js](https://github.com/shashwatak/satellite-js). SGP4 gives the satellite's position at the time in question. From your latitude and longitude, that becomes a compass direction and an elevation. The Sun's position does the rest: it decides whether your sky is dark, and whether Earth is casting its shadow across the satellite. The pass list, the sky chart, and the live map are that same calculation drawn three ways.

Magnitude, when SatPass has a standard brightness for that object, starts from the magnitude at 1000 km and a 90° phase angle. It then allows for distance, for how full the satellite looks (phase angle 0 means the Sun is behind you), and for about 0.2 magnitude of atmospheric extinction per airmass. The airmass is `1 / sin(elevation)`, and below 5° it stays at the 5° value so the number does not run away at the horizon. The standard values are the intrinsic magnitudes Heavens-Above publishes for the ISS, Tiangong's Tianhe module, Hubble, Envisat, and a few SL-16 rocket bodies. A new Starlink uses an approximate 5.0, which is the intrinsic magnitude Heavens-Above lists for a Starlink of that kind. Anything else stays blank.

## Accuracy and limits

A fresh element set is usually good to about a kilometer, which is close enough to find the pass by eye. The error grows as the set ages, which is what the age labels are for. The ISS reboosts its orbit, and a burn can move a pass by tens of seconds until CelesTrak publishes a new set.

"Visible" is still geometry: dark sky, sunlit satellite, at least 10° up. The magnitude is a separate estimate and can be off by about a magnitude when the satellite is tumbling or the sky is hazy. Terrain is ignored, so a hill or a building can hide a low pass. Atmospheric refraction is ignored too; it lifts an object on the horizon by about half a degree and shifts rise or set by a few seconds. Times are always Eastern, whatever time zone you are standing in.

To run a copy yourself, open `index.html` in a browser. `node --test` runs the magnitude, train, and cloud checks. MIT License © 2026 Luke de Wet. Orbits from [CelesTrak](https://celestrak.org/). Predictions use [satellite.js](https://github.com/shashwatak/satellite-js) (MIT). Cloud cover from [Open-Meteo](https://open-meteo.com/). Coastlines from [Natural Earth](https://www.naturalearthdata.com/).
