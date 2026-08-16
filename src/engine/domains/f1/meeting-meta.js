/**
 * Fallback meeting labels when v1/meetings is absent from the feed.
 * Keys are OpenF1 meeting_key values (2026 season + known captures).
 */

/** @type {Record<number, { name: string, circuit?: string }>} */
export const MEETING_META_2026 = {
  1279: { name: "Australian GP", circuit: "Melbourne" },
  1280: { name: "Chinese GP", circuit: "Shanghai" },
  1281: { name: "Japanese GP", circuit: "Suzuka" },
  // 1282+ fill as we capture
  1291: { name: "Hungarian GP", circuit: "Hungaroring" },
};

/**
 * @param {number|string|null} meetingKey
 * @returns {{ name: string, circuit?: string }|null}
 */
export function meetingMeta(meetingKey) {
  if (meetingKey == null) return null;
  return MEETING_META_2026[Number(meetingKey)] || null;
}

/**
 * Parse F1 livetiming static URL paths for meeting / session labels.
 * e.g. .../2026-07-26_Hungarian_Grand_Prix/2026-07-25_Qualifying/...
 * @param {string|null|undefined} url
 */
export function parseLivetimingPath(url) {
  if (!url) return null;
  const s = String(url);
  const meetingM = s.match(
    /(\d{4}-\d{2}-\d{2})_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)_Grand_Prix/i,
  );
  const sessionM = s.match(
    /\/(\d{4}-\d{2}-\d{2})_(Practice_[123]|Qualifying|Sprint_Shootout|Sprint_Qualifying|Sprint|Race)\//i,
  );
  let meetingName = null;
  if (meetingM) {
    meetingName =
      meetingM[2].replace(/_/g, " ") + " GP";
  }
  let sessionName = null;
  if (sessionM) {
    sessionName = sessionM[2].replace(/_/g, " ");
  }
  if (!meetingName && !sessionName) return null;
  return { meetingName, sessionName };
}
