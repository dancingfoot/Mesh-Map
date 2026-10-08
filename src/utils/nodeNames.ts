/**
 * Node identities: the human names behind Meshtastic node addresses.
 *
 * The dashboard used to show raw addresses everywhere (`!c931be04`). The
 * firmware tells us the names, in a few different shapes:
 *
 *   INFO  | ??:??:?? 36 [NodeInfo] Send owner !c931be04/Inov_Bas/####
 *   DEBUG | 11:36:11 48 [Router] Update changed=1 user Meshtastic 7125/7125, id=0x8ce97125, channel=1
 *   {"from":"!28a9df12","type":"nodeinfo","payload":{"longName":"Sim Ridge Relay","shortName":"SIM1"}}
 *   {"payload":{"user":{"id":"!28a9df12","longName":"…","shortName":"…"}}}
 *
 * Everything here is pure and never throws: a name is a nice-to-have, so an
 * unparseable line must simply yield `null`.
 */

import { stripAnsi } from './parser';

export interface NodeIdentity {
  /** Normalised address, e.g. `!c931be04`. */
  nodeId: string;
  /** Descriptive name (may contain spaces), e.g. `Inov_Bas`. */
  longName: string | null;
  /** Short name as shown on the device screen, e.g. `####`. */
  shortName: string | null;
}

/** Identities keyed by node address. */
export type NodeIdentityMap = Record<string, NodeIdentity>;

/** Normalises `0xc931be04` / `c931be04` / `!c931be04` to one form. */
function normaliseId(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value.startsWith('!')) value = value.slice(1);
  if (value.startsWith('0x')) value = value.slice(2);
  if (!/^[0-9a-f]{1,8}$/.test(value)) return null;
  return `!${value}`;
}

/** Trims a captured name and rejects obvious placeholders. */
function cleanName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value === '?' || value === '-') return null;
  return value;
}

/** `Send owner !c931be04/Inov_Bas/####` or `Send owner 0xc931be04/Inov_Bas/IB1`. */
const OWNER_RE = /\bowner\s+((?:0x|!)?[0-9a-fA-F]{1,8})\s*\/\s*([^/\s]+)\s*\/\s*([^/\s,]+)/;

/** `Update changed=1 user Meshtastic 7125/7125, id=0x8ce97125, channel=1` */
const USER_UPDATE_RE = /\buser\s+(.+?)\s*\/\s*([^/\s,]+)\s*,\s*id\s*=\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]{1,8})/;

/**
 * Extracts one identity from a single serial line or JSON packet.
 *
 * @returns the identity, or `null` when the line carries no usable name.
 */
export function parseNodeIdentity(line: string): NodeIdentity | null {
  if (!line || !line.trim()) return null;
  const text = stripAnsi(line);

  // --- JSON packets -------------------------------------------------------
  if (text.includes('{') && text.includes('}')) {
    const match = text.match(/\{.*\}/);
    if (match) {
      try {
        const data: unknown = JSON.parse(match[0]);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const root = data as Record<string, unknown>;
          const payload =
            root.payload && typeof root.payload === 'object'
              ? (root.payload as Record<string, unknown>)
              : root;
          const user =
            payload.user && typeof payload.user === 'object'
              ? (payload.user as Record<string, unknown>)
              : payload;

          const rawId = user.id ?? payload.id ?? root.from ?? root.sender ?? root.node_id;
          const nodeId = typeof rawId === 'string' ? normaliseId(rawId) : null;
          const longName = cleanName(
            typeof user.longName === 'string' ? user.longName : typeof user.long_name === 'string' ? user.long_name : null
          );
          const shortName = cleanName(
            typeof user.shortName === 'string' ? user.shortName : typeof user.short_name === 'string' ? user.short_name : null
          );

          if (nodeId && (longName || shortName)) return { nodeId, longName, shortName };
        }
      } catch {
        /* not JSON after all — fall through to the log formats */
      }
    }
  }

  // --- firmware log lines -------------------------------------------------
  const owner = text.match(OWNER_RE);
  if (owner) {
    const nodeId = normaliseId(owner[1]);
    if (nodeId) {
      return { nodeId, longName: cleanName(owner[2]), shortName: cleanName(owner[3]) };
    }
  }

  const update = text.match(USER_UPDATE_RE);
  if (update) {
    const nodeId = normaliseId(update[3]);
    if (nodeId) {
      return { nodeId, longName: cleanName(update[1]), shortName: cleanName(update[2]) };
    }
  }

  return null;
}

/**
 * Adds an identity to a map, returning a **new** map when something changed so
 * React sees a new reference and re-renders.
 *
 * Later lines win for a field only when they actually carry a value, so a
 * `nodeinfo` without a name never erases a name learned earlier.
 */
export function mergeNodeIdentity(map: NodeIdentityMap, identity: NodeIdentity): NodeIdentityMap {
  const existing = map[identity.nodeId];
  const longName = identity.longName ?? existing?.longName ?? null;
  const shortName = identity.shortName ?? existing?.shortName ?? null;

  if (existing && existing.longName === longName && existing.shortName === shortName) {
    return map; // no change — keep the reference so React can bail out
  }

  return { ...map, [identity.nodeId]: { nodeId: identity.nodeId, longName, shortName } };
}

/**
 * The name to show for a node: the **Meshtastic short name** first (what the
 * device itself displays, e.g. `LIS`, `IB1`), then the long name, else `null`.
 */
export function displayName(nodeId: string, identities: NodeIdentityMap | undefined): string | null {
  const identity = identities?.[nodeId];
  if (!identity) return null;
  return identity.shortName ?? identity.longName ?? null;
}

/**
 * The descriptive name, when there is one. Used as secondary text next to the
 * short label, since a short name like `IB1` says little on its own.
 */
export function displayLongName(
  nodeId: string,
  identities: NodeIdentityMap | undefined
): string | null {
  return identities?.[nodeId]?.longName ?? null;
}

/**
 * Best available label for a node key: the short name when the device has told
 * us one, otherwise the raw address so nothing ever renders blank.
 */
export function resolveNodeLabel(nodeKey: string, identities: NodeIdentityMap | undefined): string {
  return displayName(nodeKey, identities) ?? nodeKey;
}
