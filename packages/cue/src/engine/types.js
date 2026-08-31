/**
 * Shared shapes (JSDoc only — no runtime deps).
 *
 * @typedef {object} EngineConfig
 * @property {string} domain
 * @property {string} source
 * @property {boolean} useLlm
 * @property {boolean} usePrefs
 * @property {number} minSeverity
 * @property {number} dedupeMs
 * @property {string|null} [sessionKind]
 *
 * @typedef {object} IngestEvent
 * @property {string} type      - normalized e.g. 'f1.race_control', 'f1.position'
 * @property {string|number|Date|null} t
 * @property {string} [source]  - 'ndjson' | 'mqtt' | 'manual' | ...
 * @property {object} payload
 * @property {string} [topic]   - original topic if any
 * @property {object} [raw]     - original line (debug)
 *
 * @typedef {object} Moment
 * @property {string} id        - stable-ish key for dedupe
 * @property {string} type      - e.g. 'flag.vsc', 'order.leader_change'
 * @property {number} severity  - 1–9
 * @property {string|number|Date|null} t
 * @property {number[]} [entities] - driver numbers
 * @property {object} data      - facts for templates
 * @property {string} [headline] - optional pre-baked phrase
 *
 * @typedef {object} Alert
 * @property {Moment} moment
 * @property {string} text
 * @property {string} renderSource  - 'template' | 'llm' | ...
 *
 * @typedef {object} DomainModule
 * @property {() => object} createState
 * @property {(state: object, event: IngestEvent) => object} reduce
 * @property {(prev: object, next: object, event: IngestEvent) => Moment[]} detectMoments
 * @property {(moment: Moment, state: object) => string} renderMoment
 */

export {};
