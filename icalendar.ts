import { clientStore, config, datastore, editor, index } from "@silverbulletmd/silverbullet/syscalls";
import { localDateString } from "@silverbulletmd/silverbullet/lib/dates";
import { convertIcsCalendar, type IcsCalendar, type IcsEvent, type IcsDateObjects } from "ts-ics";

// ============================================================================
// Constants
// ============================================================================

const VERSION = "0.3.0";
const CACHE_KEY = "icalendar:lastSync";
const DEFAULT_CACHE_DURATION_SECONDS = 21600; // 6 hours
const DEFAULT_WATCH_INTERVAL_SECONDS = 30; // 30 seconds for watched sources

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
  watch: boolean | undefined;
  watchInterval: number | undefined;
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
      watch: typeof src.watch === "boolean" ? src.watch : undefined,
      watchInterval: typeof src.watchInterval === "number" ? src.watchInterval : undefined,
    });
  }

  return validated;
}

// ============================================================================
// Calendar Fetching & Parsing
// ============================================================================

/**
 * Generates a cache key for a specific source
 */
async function getSourceCacheKey(source: Source): Promise<string> {
  const hash = await sha256Hash(source.url);
  return `icalendar:source:${hash}`;
}

/**
 * Checks if a source needs to be synced based on its cache and watch settings
 */
async function shouldSyncSource(source: Source, globalLastSync: number, globalCacheDuration: number): Promise<boolean> {
  const now = Date.now();
  const isFileUrl = source.url.startsWith("file://");

  // For watched file:// sources, use per-source cache with watchInterval
  if (isFileUrl && source.watch) {
    const watchIntervalSeconds = source.watchInterval ?? DEFAULT_WATCH_INTERVAL_SECONDS;
    const watchIntervalMs = watchIntervalSeconds * 1000;
    const sourceCacheKey = await getSourceCacheKey(source);
    const sourceLastSync = await clientStore.get(sourceCacheKey);

    if (sourceLastSync && (now - sourceLastSync) < watchIntervalMs) {
      return false; // Don't sync, still within watch interval
    }
    return true; // Sync this watched source
  }

  // For non-watched sources, use global cache
  if (globalLastSync && (now - globalLastSync) < globalCacheDuration) {
    return false; // Don't sync, global cache is fresh
  }

  return true; // Sync based on global cache expiry
}

/**
 * Updates the cache timestamp for a source
 */
async function updateSourceCache(source: Source): Promise<void> {
  const isFileUrl = source.url.startsWith("file://");
  if (isFileUrl && source.watch) {
    const sourceCacheKey = await getSourceCacheKey(source);
    await clientStore.set(sourceCacheKey, Date.now());
  }
}

/**
 * Fetches and parses events from a single calendar source
 * Supports both HTTP(S) URLs (with optional Basic auth) and file:// URLs
 */
async function fetchAndParseCalendar(source: Source): Promise<CalendarEvent[]> {
  const isFileUrl = source.url.startsWith("file://");

  // Build request headers with authentication if credentials are provided (HTTP only)
  const headers: Record<string, string> = {};

  if (!isFileUrl && source.username && source.password) {
    const credentials = btoa(`${source.username}:${source.password}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const response = await fetch(source.url, { headers });

  if (!response.ok) {
    const error = new Error(`${isFileUrl ? 'File' : 'HTTP'} ${response.status}: ${response.statusText}`);
    console.error(`[iCalendar] ${isFileUrl ? 'File' : 'HTTP'} error:`, { source, status: response.status, statusText: response.statusText });
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
 * Supports intelligent caching: global cache for regular sources, per-source cache for watched file:// sources
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

    // Check if any source needs syncing
    let needsSync = false;
    let watchedSourceTriggered = false;

    for (const source of sources) {
      const shouldSync = await shouldSyncSource(source, lastSync, cacheDurationMs);
      if (shouldSync) {
        needsSync = true;
        if (source.url.startsWith("file://") && source.watch) {
          watchedSourceTriggered = true;
        }
      }
    }

    // If no sources need syncing, skip
    if (!needsSync) {
      const ageSeconds = Math.round((now - (lastSync || now)) / 1000);
      console.log(`[iCalendar] Using cached data (${ageSeconds}s old)`);
      return;
    }

    // Suppress notifications for background syncs of watched sources only
    const showNotification = !watchedSourceTriggered || sources.length > 1;
    if (showNotification) {
      console.log(`[iCalendar] Syncing ${sources.length} calendar source(s)...`);
      await editor.flashNotification("Syncing calendars...", "info");
    } else {
      console.log(`[iCalendar] Background sync triggered by watched source`);
    }

    // Sync all sources to maintain complete index
    const allEvents: CalendarEvent[] = [];
    let successCount = 0;

    for (const source of sources) {
      const identifier = source.name || source.url;

      try {
        const events = await fetchAndParseCalendar(source);
        allEvents.push(...events);
        await updateSourceCache(source);
        successCount++;
      } catch (err) {
        console.error(`[iCalendar] Failed to sync "${identifier}":`, err);
        if (showNotification) {
          await editor.flashNotification(
            `Failed to sync "${identifier}"`,
            "error"
          );
        }
      }
    }

    await index.indexObjects("$icalendar", allEvents);
    await clientStore.set(CACHE_KEY, now);

    if (showNotification) {
      const summary = `Synced ${allEvents.length} events from ${successCount}/${sources.length} source(s)`;
      console.log(`[iCalendar] ${summary}`);
      await editor.flashNotification(summary, "info");
    }
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
 * Background watcher for file:// sources with watch=true
 * Continuously monitors and syncs watched sources at their specified intervals
 */
async function backgroundWatch() {
  try {
    const sources = await getSources();
    const watchedSources = sources.filter(s => s.url.startsWith("file://") && s.watch);

    if (watchedSources.length === 0) {
      return; // No watched sources, stop watching
    }

    // Find the minimum watch interval
    const minInterval = Math.min(
      ...watchedSources.map(s => (s.watchInterval ?? DEFAULT_WATCH_INTERVAL_SECONDS) * 1000)
    );

    // Trigger sync (which will check each source's individual cache)
    await syncCalendars();

    // Schedule next watch cycle
    setTimeout(() => backgroundWatch(), minInterval);
  } catch (err) {
    console.error("[iCalendar] Background watch error:", err);
    // Retry after default interval
    setTimeout(() => backgroundWatch(), DEFAULT_WATCH_INTERVAL_SECONDS * 1000);
  }
}

/**
 * Starts background watching for file:// sources
 * Called on editor initialization if any sources have watch=true
 */
export async function startWatcher() {
  const sources = await getSources();
  const hasWatchedSources = sources.some(s => s.url.startsWith("file://") && s.watch);

  if (hasWatchedSources) {
    console.log("[iCalendar] Starting background watcher for file:// sources");
    await backgroundWatch();
  }
}

/**
 * Shows the plugin version
 */
export async function showVersion() {
  await editor.flashNotification(`iCalendar Plug ${VERSION}`, "info");
}
