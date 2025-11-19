import { clientStore, config, datastore, editor, index } from "@silverbulletmd/silverbullet/syscalls";
import { localDateString } from "@silverbulletmd/silverbullet/lib/dates";
import { convertIcsCalendar, type IcsCalendar, type IcsEvent, type IcsDateObjects } from "ts-ics";

// ============================================================================
// Constants
// ============================================================================

const VERSION = "0.2.1";
const CACHE_KEY = "icalendar:lastSync";
const DEFAULT_CACHE_DURATION_SECONDS = 21600; // 6 hours

// ============================================================================
// Types
// ============================================================================

/**
 * Recursively converts all Date objects to strings in a type
 */
type DateToString<T> = T extends Date ? string
  : T extends IcsDateObjects ? string
  : T extends object ? { [K in keyof T]: DateToString<T[K]> }
  : T extends Array<infer U> ? Array<DateToString<U>>
  : T;

/**
 * Configuration for a calendar source
 */
interface Source {
  url: string;
  name: string | undefined;
  username: string | undefined;
  password: string | undefined;
}

/**
 * Plugin configuration structure
 */
interface PlugConfig {
  sources: Source[];
  cacheDuration: number | undefined;
}

/**
 * Calendar event object indexed in SilverBullet
 * Queryable via: `ical-event` from index
 *
 * Extends IcsEvent with all Date fields converted to strings recursively
 */
interface CalendarEvent extends DateToString<IcsEvent> {
  ref: string;
  tag: "ical-event";
  sourceName: string | undefined;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Type guard for IcsDateObjects
 */
function isIcsDateObjects(obj: any): obj is IcsDateObjects {
  return obj && typeof obj === 'object' && ('date' in obj && 'type' in obj);
}

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
 * Recursively converts all Date objects and ISO date strings to strings
 * Handles nested objects like {date: Date, local: {date: Date, timezone: string}}
 */
function convertDatesToStrings<T>(obj: T): DateToString<T> {
  if (obj === null || obj === undefined) {
    return obj as DateToString<T>;
  }

  if (obj instanceof Date) {
    return localDateString(obj) as DateToString<T>;
  }
  if (isIcsDateObjects(obj) && obj.date instanceof Date) {
    return localDateString(obj.date) as DateToString<T>;
  }

  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
    return localDateString(new Date(obj)) as DateToString<T>;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => convertDatesToStrings(item)) as DateToString<T>;
  }

  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = convertDatesToStrings((obj as any)[key]);
      }
    }
    return result as DateToString<T>;
  }

  return obj as DateToString<T>;
}

// ============================================================================
// Configuration Functions
// ============================================================================

/**
 * Retrieves and validates configured calendar sources
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
      username: typeof src.username === "string" ? src.username : undefined,
      password: typeof src.password === "string" ? src.password : undefined,
    });
  }

  return validated;
}

// ============================================================================
// Calendar Fetching & Parsing
// ============================================================================

/**
 * Fetches and parses events from a single calendar source
 */
async function fetchAndParseCalendar(source: Source): Promise<CalendarEvent[]> {
  // Build request headers with authentication if credentials are provided
  const headers: Record<string, string> = {};

  if (source.username && source.password) {
    const credentials = btoa(`${source.username}:${source.password}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const response = await fetch(source.url, { headers });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
    console.error(`[iCalendar] HTTP error:`, { source, status: response.status, statusText: response.statusText });
    throw error;
  }

  const icsData = await response.text();
  const calendar: IcsCalendar = convertIcsCalendar(undefined, icsData);

  if (!calendar.events || calendar.events.length === 0) {
    return [];
  }

  return await Promise.all(calendar.events.map(async (icsEvent: IcsEvent): Promise<CalendarEvent> => {
    // Create unique ref by start date with UID or summary (handles recurring events)
    const uniqueKey = `${icsEvent.start?.date || ''}${icsEvent.uid || icsEvent.summary || ''}`;
    const ref = await sha256Hash(uniqueKey);

    return convertDatesToStrings({
      ...icsEvent,

      ref,
      tag: "ical-event" as const,
      sourceName: source.name,
    });
  }));
}

// ============================================================================
// Exported Commands
// ============================================================================

/**
 * Synchronizes calendar events from configured sources and indexes them
 */
export async function syncCalendars() {
  try {
    const plugConfig = await config.get<PlugConfig>("icalendar", { sources: [] });
    const cacheDurationSeconds = plugConfig.cacheDuration ?? DEFAULT_CACHE_DURATION_SECONDS;
    const cacheDurationMs = cacheDurationSeconds * 1000;

    const sources = await getSources();
    if (sources.length === 0) {
      return;
    }

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

    await index.indexObjects("$icalendar", allEvents);
    await clientStore.set(CACHE_KEY, now);

    const summary = `Synced ${allEvents.length} events from ${successCount}/${sources.length} source(s)`;
    console.log(`[iCalendar] ${summary}`);
    await editor.flashNotification(summary, "info");
  } catch (err) {
    console.error("[iCalendar] Sync failed:", err);
    await editor.flashNotification("Failed to sync calendars", "error");
  }
}

/**
 * Forces a fresh sync by clearing cache and syncing calendars
 */
export async function forceSync() {
  await clientStore.del(CACHE_KEY);
  console.log("[iCalendar] Cache cleared, forcing fresh sync");
  await editor.flashNotification("Forcing fresh calendar sync...", "info");
  await syncCalendars();
}

/**
 * Clears all indexed calendar events and cache
 */
export async function clearCache() {
  if (!await editor.confirm(
    "Are you sure you want to clear all calendar events and cache? This will remove all indexed calendar data."
  )) {
    return;
  }

  try {
    const fileName = "$icalendar";
    console.log("[iCalendar] Clearing index for", fileName);

    const indexKey = "idx";
    const pageKey = "ridx";
    const allKeys: any[] = [];

    const pageKeys = await datastore.query({
      prefix: [pageKey, fileName],
    });

    for (const { key } of pageKeys) {
      allKeys.push(key);
      allKeys.push([indexKey, ...key.slice(2), fileName]);
    }

    if (allKeys.length > 0) {
      await datastore.batchDel(allKeys);
      console.log("[iCalendar] Deleted", allKeys.length, "entries");
    }

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
