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
  # Global cache duration (applies to all non-watched sources)
  cacheDuration: 21600  # optional, in seconds, default: 6 hours

  # Calendar sources
  sources:
  # Example 1: Public HTTP calendar
  - url: https://example.com/calendar.ics
    name: Example calendar

  # Example 2: Authenticated CalDAV (HTTP Basic Auth)
  - url: https://caldav.example.com/user/calendar/
    name: Authenticated calendar
    username: myuser
    password: mypassword

  # Example 3: Local file with automatic watching (for local CalDAV servers like Radicale)
  - url: file:///path/to/radicale/collections/user/calendar/calendar.ics
    name: Local Radicale Calendar
    watch: true
    watchInterval: 30  # optional, in seconds, default: 30
```

#### URL Types

This plug supports three types of calendar sources:

1. **Public HTTP(S) URLs**: Standard iCalendar URLs (`.ics` files)
2. **Authenticated HTTP(S) URLs**: CalDAV or iCalendar URLs requiring Basic authentication
3. **Local file:// URLs**: Direct filesystem access to `.ics` files (useful for local CalDAV servers)

#### Authentication

The plug supports Basic HTTP authentication for CalDAV sources that require credentials. Add `username` and `password` fields to your source configuration:

- **username**: Your CalDAV username (required for auth)
- **password**: Your CalDAV password (required for auth)

Both fields are optional and only apply to HTTP(S) URLs. Authentication is automatically skipped for `file://` URLs.

#### Real-time Sync with File Watching

For local CalDAV servers (like Radicale), you can enable automatic file watching to get near real-time updates:

- **watch**: Set to `true` to enable automatic syncing (only for `file://` URLs)
- **watchInterval**: Sync interval in seconds (default: 30 seconds)

When watch mode is enabled:
- The plug monitors the file for changes every `watchInterval` seconds
- Syncs happen automatically in the background without notifications
- Other (non-watched) sources are also refreshed when a watched source triggers a sync
- Perfect for local Radicale servers where you can point directly to the `.ics` files

Instructions to get the source URL for some calendar services:

- **Radicale** (local CalDAV server):
  - **HTTP Method**: Use `http://localhost:5232/user/calendar/` with username/password
  - **File Method (recommended for real-time sync)**: Use `file:///path/to/radicale/collections/user/calendar.ics` with `watch: true`
  - Default Radicale storage location: `~/.var/lib/radicale/collections/`
  - Example: `file:///home/user/.var/lib/radicale/collections/collection-root/user/calendar.ics`

- **Nextcloud** ([source](https://help.nextcloud.com/t/how-to-access-the-calendar-ics-file-via-url/7880)):
  - Edit calendar (pencil icon to the right of the name)
  - Share calendar link
  - Details (three dots icon), copy subscription link
  - Verify that the link ends with `?export`
  - **Note**: For private calendars, provide your Nextcloud username and password (or app-specific password)

- **Google Calendar** ([source](https://support.google.com/calendar/answer/37648?hl=en#zippy=%2Cget-your-calendar-view-only)):
  - Calendar settings (pencil icon to the right of the name)
  - Settings and Sharing, scroll down to Integrate calendar
  - Copy the link for Secret address in iCal format

![Screenshot of getting the URL from Nextcloud Calendar](./url-nextcloud.png)

## Usage

After configuration, run the `{[iCalendar: Sync]}` command to synchronize calendar events. The plug will cache the results for 6 hours by default (configurable via `cacheDuration` in config).

To bypass the cache and force an immediate sync, use the `{[iCalendar: Force Sync]}` command.

To completely clear all indexed events and cache (useful for troubleshooting), use the `{[iCalendar: Clear All Events]}` command.

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
- Use native filesystem watching (Deno.watchFs) if available in SilverBullet plug environment

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
