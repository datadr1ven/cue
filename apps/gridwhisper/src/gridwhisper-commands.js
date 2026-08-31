/**
 * Telegram / menu commands for GridWhisper (user-facing).
 * Used by setMyCommands on the CF Worker (and any future Node bot).
 */

/** @type {{ command: string, description: string }[]} */
export const GRIDWHISPER_USER_COMMANDS = [
  { command: "start", description: "Subscribe to race alerts" },
  { command: "help", description: "How GridWhisper works" },
  { command: "status", description: "Subscription status" },
  { command: "stop", description: "Unsubscribe from alerts" },
];
