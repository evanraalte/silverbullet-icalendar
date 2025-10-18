import { clientStore, config, datastore, editor, index } from "@silverbulletmd/silverbullet/syscalls";
import { localDateString } from "@silverbulletmd/silverbullet/lib/dates";
import { parseIcsCalendar, type VCalendar } from "ts-ics";

const VERSION = "0.2.0";
const CACHE_KEY = "icalendar:lastSync";
const DEFAULT_CACHE_DURATION_SECONDS = 21600; // 6 hours

/**
 * Creates a SHA-256 hash of a string (hex encoded)
 */
async function sha256Hash(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Configuration for a calendar source
 */
interface Source {
  /** URL to the .ics file */
  url: string;
  /** Optional name for the source (used in sourceName field) */
  name: string | undefined;
}

/**
 * Plugin configuration structure
 */
interface PlugConfig {
  /** List of calendar sources to sync */
  sources: Source[];
  /** Cache duration in seconds (default: 21600 = 6 hours) */
  cacheDuration: number | undefined;
}

/**
 * Calendar event object indexed in SilverBullet
 * Queryable via: query[from index.tag "ical-event" ...]
 */
interface CalendarEvent {
  // Index metadata
  /** Unique identifier (event UID or SHA-256 hash) */
  ref: string;
  /** Object tag for LIQ queries */
  tag: "ical-event";

  // Event details
  /** Event title */
  summary: string | undefined;
  /** Event description/notes */
  description: string | undefined;
  /** Event location */
  location: string | undefined;

  // Timestamps (formatted with localDateString)
  /** Event start date/time */
  start: string | undefined;
  /** Event end date/time */
  end: string | undefined;
  /** Event creation date/time */
  created: string | undefined;
  /** Last modification date/time */
  lastModified: string | undefined;

  // Source tracking
  /** Name of the calendar source */
  sourceName: string | undefined;
}

/**
 * Synchronizes calendar events from configured sources and indexes them.
 * This command fetches events from all configured iCalendar sources and
 * makes them queryable via Lua Integrated Query.
 */
export async function syncCalendars() {
  try {
    // Get configuration (including cache duration)
    const plugConfig = await config.get<PlugConfig>("icalendar", { sources: [] });
    const cacheDurationSeconds = plugConfig.cacheDuration ?? DEFAULT_CACHE_DURATION_SECONDS;
    const cacheDurationMs = cacheDurationSeconds * 1000;

    const sources = await getSources();
    if (sources.length === 0) {
      // Ignore processing if no sources are declared
      return;
    }

    // Check cache to avoid too frequent syncs
    const lastSync = await clientStore.get(CACHE_KEY);
    const now = Date.now();

    if (lastSync && (now - lastSync) < cacheDurationMs) {
      const ageSeconds = Math.round((now - lastSync) / 1000);
      console.log(`[iCalendar] Using cached data (${ageSeconds}s old)`);
      return;
    }

    console.log(`[iCalendar] Syncing ${sources.length} calendar source(s)...`);
    await editor.flashNotification("Syncing calendars...", "info");

    const allEvents: CalendarEvent[] = [];
    let successCount = 0;

    for (const source of sources) {
      const identifier = source.name || source.url;

      try {
        const events = await fetchAndParseCalendar(source);
        allEvents.push(...events);
        successCount++;
      } catch (err) {
        console.error(`[iCalendar] Failed to sync "${identifier}":`, err);
        await editor.flashNotification(
          `Failed to sync "${identifier}"`,
          "error"
        );
      }
    }

    // Index all events in SilverBullet's object store
    // Using a virtual page "$icalendar" to store external calendar data
    await index.indexObjects("$icalendar", allEvents);

    // Update cache timestamp
    await clientStore.set(CACHE_KEY, now);

    const summary = `Synced ${allEvents.length} events from ${successCount}/${sources.length} source(s)`;
    console.log(`[iCalendar] ${summary}`);
    await editor.flashNotification(summary, "info");
  } catch (err) {
    console.error("[iCalendar] Sync failed:", err);
    await editor.flashNotification(
      "Failed to sync calendars",
      "error"
    );
  }
}

/**
 * Fetches and parses events from a single calendar source
 */
async function fetchAndParseCalendar(source: Source): Promise<CalendarEvent[]> {
  const response = await fetch(source.url);

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
    console.error(`[iCalendar] HTTP error:`, { source, status: response.status, statusText: response.statusText });
    throw error;
  }

  const icsData = await response.text();
  const calendar: VCalendar = parseIcsCalendar(icsData);

  if (!calendar.events || calendar.events.length === 0) {
    return [];
  }

  return await Promise.all(calendar.events.map(async (icsEvent): Promise<CalendarEvent> => {
    // Create a unique ref using UID if available, otherwise hash unique fields
    const ref = icsEvent.uid || await sha256Hash(`${icsEvent.uid || ''}${icsEvent.start}${icsEvent.summary}`);

    return {
      ref,
      tag: "ical-event" as const,
      summary: icsEvent.summary,
      description: icsEvent.description,
      location: icsEvent.location,
      start: icsEvent.start ? localDateString(icsEvent.start.date) : undefined,
      end: icsEvent.end ? localDateString(icsEvent.end.date) : undefined,
      created: icsEvent.created ? localDateString(icsEvent.created.date) : undefined,
      lastModified: icsEvent.lastModified ? localDateString(icsEvent.lastModified.date) : undefined,
      sourceName: source.name,
    };
  }));
}

/**
 * Retrieves configured calendar sources from CONFIG
 */
async function getSources(): Promise<Source[]> {
  const plugConfig = await config.get<PlugConfig>("icalendar", { sources: [] });

  if (!plugConfig.sources || !Array.isArray(plugConfig.sources)) {
    console.error("[iCalendar] Invalid configuration:", { plugConfig });
    return [];
  }

  if (plugConfig.sources.length === 0) {
    return [];
  }

  const validated: Source[] = [];
  for (const src of plugConfig.sources) {
    if (typeof src.url !== "string") {
      console.error("[iCalendar] Invalid source (missing url):", src);
      continue;
    }
    validated.push({
      url: src.url,
      name: typeof src.name === "string" ? src.name : undefined,
    });
  }

  return validated;
}

/**
 * Forces a fresh sync by clearing cache and then syncing calendars
 */
export async function forceSync() {
  await clientStore.del(CACHE_KEY);
  console.log("[iCalendar] Cache cleared, forcing fresh sync");
  await editor.flashNotification("Forcing fresh calendar sync...", "info");
  await syncCalendars();
}

/**
 * Clears the calendar cache by removing the indexed events page
 * Implementation based on SilverBullet's clearFileIndex:
 * https://github.com/silverbulletmd/silverbullet/blob/main/plugs/index/api.ts#L49-L69
 */
export async function clearCache() {
  // Ask for confirmation before clearing the cache
  if (!await editor.confirm(
    "Are you sure you want to clear all calendar events and cache? This will remove all indexed calendar data."
  )) {
    return;
  }

  try {
    const fileName = "$icalendar";
    console.log("[iCalendar] Clearing index for", fileName);

    // Implementation based on SilverBullet's clearFileIndex function
    // https://github.com/silverbulletmd/silverbullet/blob/main/plugs/index/api.ts#L49-L69
    const indexKey = "idx";
    const pageKey = "ridx";

    // Query all keys for this file
    const allKeys: any[] = [];

    // Get all page keys for this file: [pageKey, $icalendar, ...key]
    const pageKeys = await datastore.query({
      prefix: [pageKey, fileName],
    });

    for (const { key } of pageKeys) {
      allKeys.push(key);
      // Also add corresponding index keys: [indexKey, tag, ref, $icalendar]
      // where tag is "ical-event" and ref is the event reference
      allKeys.push([indexKey, ...key.slice(2), fileName]);
    }

    // Batch delete all found keys
    if (allKeys.length > 0) {
      await datastore.batchDel(allKeys);
      console.log("[iCalendar] Deleted", allKeys.length, "events");
    }

    // Also clear the sync timestamp cache
    await clientStore.del(CACHE_KEY);

    console.log("[iCalendar] Calendar index and cache cleared");
    await editor.flashNotification("Calendar index and cache cleared", "info");
  } catch (err) {
    console.error("[iCalendar] Failed to clear cache:", err);
    await editor.flashNotification(
      `Failed to clear cache: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
  }
}

/**
 * Shows the plugin version
 */
export async function showVersion() {
  await editor.flashNotification(`iCalendar Plug ${VERSION}`, "info");
}
