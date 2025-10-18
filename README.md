# SilverBullet iCalendar Plug

`silverbullet-icalendar` is a [Plug](https://silverbullet.md/Plugs) for [SilverBullet](https://silverbullet.md/) which I made for my girlfriend.
It reads external [iCalendar](https://en.wikipedia.org/wiki/ICalendar) data, also known as iCal and `.ics` format, used in CalDAV protocol.

**Note**: This version (0.2.0+) is compatible with **SilverBullet v2 only**. For SilverBullet v1, use version 0.1.0.

## Installation

Run the {[Plugs: Add]} command in SilverBullet and add paste this URI into the dialog box:

```
ghr:Maarrk/silverbullet-icalendar
```

Then run the {[Plugs: Update]} command and off you go!

### Configuration

This plug is configured with [Space Config](https://silverbullet.md/Space%20Config), short example:

```yaml
icalendar:
  # where to get the iCalendar data from
  sources:
  - url: https://example.com/calendar.ics
    # this will be set as sourceName on all results from this source
    name: Example calendar
```

Instructions to get the source URL for some calendar services:

- Nextcloud ([source](https://help.nextcloud.com/t/how-to-access-the-calendar-ics-file-via-url/7880)):
  - Edit calendar (pencil icon to the right of the name)
  - Share calendar link
  - Details (three dots icon), copy subscription link
  - Verify that the link ends with `?export`
- Google Calendar ([source](https://support.google.com/calendar/answer/37648?hl=en#zippy=%2Cget-your-calendar-view-only)): 
  - Calendar settings (pencil icon to the right of the name)
  - Settings and Sharing, scroll down to Integrate calendar
  - Copy the link for Secret address in iCal format

![Screenshot of getting the URL from Nextcloud Calendar](./url-nextcloud.png)

## Usage

After configuration, run the `{[iCalendar: Sync]}` command to synchronize calendar events. The plug will cache the results for 6 hours by default (configurable via `cacheDuration` in config).

Events are indexed with the tag `ical-event` and can be queried using Lua Integrated Query (LIQ).

### Examples

Select events that start on a given date:

~~~
```md
${query[[
  from index.tag "ical-event" 
  where start:startsWith "2024-01-04"
  select {summary=summary, description=description}
]]}
```
~~~

Get the next 5 upcoming events:
```md
${query[[
  from index.tag "ical-event"
  where start > os.date("%Y-%m-%d")
  order by start
  limit 5
]]}
```
~~~

## Roadmap

- Cache the calendar according to `REFRESH-INTERVAL` or `X-PUBLISHED-TTL`
- More indexed object types:
  - `ical-todo` for `VTODO` components
  - `ical-calendar` showing information about configured calendars
- Support `file://` URL scheme (use an external script or filesystem instead of authentication on CalDAV)

## Contributing

Pull requests with short instructions for various calendar services are welcome.
If you find bugs, report them on the [issue tracker on GitHub](https://github.com/Maarrk/silverbullet-icalendar/issues).

### Building from source

To build this plug, make sure you have [SilverBullet installed](https://silverbullet.md/Install). Then, build the plug with:

```shell
deno task build
```

Or to watch for changes and rebuild automatically

```shell
deno task watch
```

Then, copy the resulting `.plug.js` file into your space's `_plug` folder. Or build and copy in one command:

```shell
deno task build && cp *.plug.js /my/space/_plug/
```

SilverBullet will automatically sync and load the new version of the plug (or speed up this process by running the {[Sync: Now]} command).

## License

MIT, following SilverBullet
