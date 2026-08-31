/**
 * Wall-clock UTC prefixes for ops logs (reconnect / capture heartbeats).
 * Distinct from event-time stamps on alerts (those stay feed-derived).
 */

export function wallUtc() {
  return new Date().toISOString();
}

export function logInfo(...args) {
  console.log(wallUtc(), ...args);
}

export function logWarn(...args) {
  console.warn(wallUtc(), ...args);
}

export function logError(...args) {
  console.error(wallUtc(), ...args);
}
