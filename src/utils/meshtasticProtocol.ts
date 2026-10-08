/**
 * Meshtastic **phone API** over Web Serial: framing, protobuf readers and a
 * streaming scanner that separates firmware log text from binary messages.
 *
 * ## Why this exists
 *
 * The dashboard normally reads the port as plain text (the firmware console
 * log). Remote nodes then show up only as addresses such as `!4058f711`, because
 * the firmware almost never prints their names. The official clients instead
 * speak the phone API: they ask the device for its node database and get back
 * protobuf `NodeInfo` records that carry each node's long/short name. This
 * module implements just enough of that protocol — dependency-free — to get
 * those names.
 *
 * ## Wire format (verified against meshtastic/protobufs + meshtastic/python)
 *
 * Serial framing (`stream_interface.py`):
 *
 *     START1 = 0x94
 *     START2 = 0xC3
 *     header = [START1, START2, (length >> 8) & 0xFF, length & 0xFF]  // BIG-endian
 *     frame  = header + protobuf_payload
 *
 * Protobuf fields (`mesh.proto`):
 *
 *     ToRadio:   want_config_id = 3   (uint32)
 *     FromRadio: node_info = 4 (NodeInfo), config_complete_id = 7 (uint32)
 *     NodeInfo:  num = 1 (uint32), user = 2 (User)
 *     User:      id = 1 (string), long_name = 2 (string), short_name = 3 (string)
 *
 * ## Contract
 *
 * Every function here is pure and **never throws**: a malformed frame, a
 * truncated varint or a stray start marker in log output must degrade to log
 * text or `null`, never to an exception. Nothing is allowed to grow without
 * bound, so the scanner caps its internal buffer.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** First byte of a framed phone-API message (`START1`). */
export const START1 = 0x94;

/** Second byte of a framed phone-API message (`START2`). */
export const START2 = 0xc3;

/**
 * Largest frame payload we are willing to wait for.
 *
 * A real `NodeInfo` is tens of bytes, so 4096 is generous. Anything larger is
 * assumed to be a `0x94 0xC3` byte pair that happened to appear inside log
 * text, and is emitted as text instead of swallowing the stream.
 */
export const MAX_FRAME_LENGTH = 4096;

/**
 * Hard cap on bytes retained between `push()` calls. If a caller ever hands us
 * more than this, the oldest bytes are dropped so memory cannot grow without
 * bound. A partially received frame can never exceed `MAX_FRAME_LENGTH + 4`
 * bytes, so this only ever trims pathological input.
 */
export const MAX_BUFFER_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/** One node discovered in the device's node database. */
export interface DeviceNodeInfo {
  /** Normalised to `"!4058f711"` (lowercase, padded to 8 hex digits, `!` prefix). */
  nodeId: string;
  longName: string | null;
  shortName: string | null;
}

/**
 * A GPS fix taken from a `MeshPacket` frame.
 *
 * Once the dashboard attaches as a phone-API client, the device delivers
 * received packets to us as protobuf frames — and some fixes arrive ONLY that
 * way, with no corresponding `POSITION node=…` line in the text log. Those
 * packets used to be discarded, so nodes visible in Telemetry never appeared on
 * the map.
 */
export interface DevicePosition {
  /** `!4058f711`, from `MeshPacket.from`. */
  nodeId: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  satellites: number | null;
  /** Epoch seconds from `Position.time`, when present. */
  time: number | null;
}

/** Result of feeding raw serial bytes through the scanner. */
export interface ScanResult {
  /** Text bytes that were NOT part of a framed message, decoded as UTF-8. */
  text: string;
  /** Node records decoded from any complete frames in this chunk. */
  nodeInfos: DeviceNodeInfo[];
  /** LIVE GPS fixes decoded from `MeshPacket` frames (the phone-API stream). */
  positions: DevicePosition[];
  /**
   * LAST-KNOWN fixes taken from `NodeInfo.position` in the device's node
   * database — every node the radio remembers, whether or not it is currently
   * transmitting. These can be hours old, so they are reported separately and
   * rendered as stale rather than passed off as live.
   */
  lastKnownPositions: DevicePosition[];
  /** Unique node names this scanner has seen since it was created. */
  knownNodeNames: number;
  /** True once the device reported config_complete_id (end of the DB dump). */
  configComplete: boolean;
  /** Frames skipped because they were malformed (diagnostics only). */
  droppedFrames: number;
}

/* -------------------------------------------------------------------------- */
/* Protobuf field numbers                                                      */
/* -------------------------------------------------------------------------- */

const TO_RADIO_WANT_CONFIG_ID = 3;

const FROM_RADIO_PACKET = 2;
const FROM_RADIO_NODE_INFO = 4;
const FROM_RADIO_CONFIG_COMPLETE_ID = 7;

const MESH_PACKET_FROM = 1; // fixed32
const MESH_PACKET_DECODED = 4; // Data

const DATA_PORTNUM = 1;
const DATA_PAYLOAD = 2;

const PORTNUM_POSITION = 3;

const POSITION_LATITUDE_I = 1; // sfixed32, degrees * 1e7
const POSITION_LONGITUDE_I = 2; // sfixed32, degrees * 1e7
const POSITION_ALTITUDE = 3; // int32
const POSITION_TIME = 4; // fixed32 (epoch seconds)
const POSITION_SATS = 19; // uint32

/** Meshtastic scales lat/lon into integers by this factor. */
const LAT_LON_SCALE = 1e7;

const NODE_INFO_NUM = 1;
const NODE_INFO_USER = 2;
const NODE_INFO_POSITION = 3;

const USER_ID = 1;
const USER_LONG_NAME = 2;
const USER_SHORT_NAME = 3;

/** Shared decoder: `TextDecoder` is stateless when used without `stream: true`. */
const UTF8_DECODER = new TextDecoder('utf-8');

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/** Encodes a non-negative integer as a base-128 varint. */
function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let remaining = Number.isFinite(value) ? Math.floor(value) : 0;
  if (remaining < 0) remaining = 0;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    out.push(remaining > 0 ? byte + 0x80 : byte);
  } while (remaining > 0);
  return out;
}

/** Wraps a protobuf payload in the `0x94 0xC3` big-endian-length framing. */
function frame(payload: number[]): Uint8Array {
  const length = payload.length;
  return Uint8Array.from([START1, START2, (length >> 8) & 0xff, length & 0xff, ...payload]);
}

/**
 * Builds the "send me your config + node database" request.
 *
 * `ToRadio.want_config_id = 3` (varint), wrapped in the `0x94 0xC3` framing.
 * The device answers with a stream of `FromRadio` frames — one `NodeInfo` per
 * node — terminated by `FromRadio.config_complete_id`.
 *
 * @param configId nonce echoed back by the device; defaults to `1`.
 */
export function encodeWantConfigRequest(configId = 1): Uint8Array {
  const id = Number.isFinite(configId)
    ? Math.floor(Math.abs(configId)) % 4294967296
    : 1;
  const payload = [
    ...encodeVarint((TO_RADIO_WANT_CONFIG_ID << 3) | 0),
    ...encodeVarint(id),
  ];
  return frame(payload);
}

/* -------------------------------------------------------------------------- */
/* Protobuf reading                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reads a base-128 varint starting at `offset`.
 *
 * Uses multiplication rather than `<<`/`|` so multi-byte varints are not
 * truncated to 32 bits. Values above `Number.MAX_SAFE_INTEGER` (only reachable
 * from a 10-byte varint) are necessarily approximate, but they never wrap and
 * never throw.
 *
 * @returns the value and the offset just past it, or `null` when the varint is
 *   truncated or longer than the 10 bytes protobuf allows.
 */
export function readVarint(
  bytes: Uint8Array,
  offset: number
): { value: number; offset: number } | null {
  if (!bytes || offset < 0 || offset >= bytes.length) return null;

  let value = 0;
  let scale = 1;
  let cursor = offset;

  for (let i = 0; i < 10; i += 1) {
    if (cursor >= bytes.length) return null; // truncated
    const byte = bytes[cursor];
    cursor += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    scale *= 128;
  }
  return null; // more than 10 bytes: not a valid varint
}

/** One decoded protobuf field, with the offset just past it. */
interface ProtoField {
  fieldNumber: number;
  wireType: number;
  /** Set for wire type 0 only. Exact only below 2^53. */
  varintValue: number | null;
  /**
   * Set for wire type 0 only: the varint's low 32 bits, sign-extended.
   *
   * Needed because `int32` negatives travel as 10-byte two's-complement varints
   * (e.g. `altitude = -7` → `0xFFFFFFFFFFFFFFF9`), and float64 cannot hold that
   * value exactly — `varintValue` rounds it to 2^64, losing the payload.
   */
  int32Value: number | null;
  /** Set for wire types 1, 2 and 5 only. */
  bytes: Uint8Array | null;
  offset: number;
}

/**
 * Reads one field. Wire types 0/1/2/5 are understood; the deprecated group
 * types (3/4) and the reserved types (6/7) make the message malformed rather
 * than silently mis-parsed. Unknown *fields* of a known wire type are skipped
 * correctly, which is what lets us ignore everything we do not model.
 */
function readField(bytes: Uint8Array, offset: number): ProtoField | null {
  const key = readVarint(bytes, offset);
  if (!key) return null;

  const wireType = key.value & 0x07;
  const fieldNumber = Math.floor(key.value / 8);
  if (fieldNumber <= 0) return null; // field 0 does not exist
  const cursor = key.offset;

  if (wireType === 0) {
    const value = readVarint(bytes, cursor);
    if (!value) return null;
    return {
      fieldNumber,
      wireType,
      varintValue: value.value,
      int32Value: readVarintLow32(bytes, cursor),
      bytes: null,
      offset: value.offset,
    };
  }
  if (wireType === 1) {
    if (cursor + 8 > bytes.length) return null;
    return {
      fieldNumber,
      wireType,
      varintValue: null,
      int32Value: null,
      bytes: bytes.slice(cursor, cursor + 8),
      offset: cursor + 8,
    };
  }
  if (wireType === 2) {
    const length = readVarint(bytes, cursor);
    if (!length) return null;
    const end = length.offset + length.value;
    if (!Number.isFinite(end) || end > bytes.length) return null; // length past the end
    return {
      fieldNumber,
      wireType,
      varintValue: null,
      int32Value: null,
      bytes: bytes.slice(length.offset, end),
      offset: end,
    };
  }
  if (wireType === 5) {
    if (cursor + 4 > bytes.length) return null;
    return {
      fieldNumber,
      wireType,
      varintValue: null,
      int32Value: null,
      bytes: bytes.slice(cursor, cursor + 4),
      offset: cursor + 4,
    };
  }
  return null;
}

/** Decodes UTF-8, falling back to an empty string on hostile input. */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return '';
  }
}

/** Normalises a node address to `!` + 8 lowercase hex digits. */
export function normaliseNodeId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (value.startsWith('!')) value = value.slice(1);
  if (value.startsWith('0x')) value = value.slice(2);
  if (!/^[0-9a-f]{1,8}$/.test(value)) return null;
  return `!${value.padStart(8, '0')}`;
}

/** `num` (uint32) to the canonical `!4058f711` form. */
function nodeIdFromNumber(num: number): string | null {
  if (!Number.isFinite(num) || num < 0) return null;
  const value = Math.floor(num) % 4294967296;
  return `!${value.toString(16).padStart(8, '0')}`;
}

/** Fields we keep from a `User` sub-message. */
interface DecodedUser {
  id: string | null;
  longName: string | null;
  shortName: string | null;
}

/** Decodes `User`. Returns `null` only when the sub-message is malformed. */
function decodeUser(bytes: Uint8Array): DecodedUser | null {
  const user: DecodedUser = { id: null, longName: null, shortName: null };
  let offset = 0;

  while (offset < bytes.length) {
    const field = readField(bytes, offset);
    if (!field) return null;
    offset = field.offset;
    if (field.wireType !== 2 || !field.bytes) continue; // unknown/wrong type: skip

    if (field.fieldNumber === USER_ID) user.id = decodeUtf8(field.bytes);
    else if (field.fieldNumber === USER_LONG_NAME) user.longName = decodeUtf8(field.bytes);
    else if (field.fieldNumber === USER_SHORT_NAME) user.shortName = decodeUtf8(field.bytes);
  }
  return user;
}

/**
 * Decodes `NodeInfo`.
 *
 * The address comes from `user.id` when present and valid, otherwise from the
 * numeric `num`. A record with neither yields `null`; a record with `num` but
 * no `user` yields `{ nodeId, longName: null, shortName: null }`.
 */
function decodeNodeInfo(bytes: Uint8Array): DeviceNodeInfo | null {
  let num: number | null = null;
  let userId: string | null = null;
  let longName: string | null = null;
  let shortName: string | null = null;
  let offset = 0;

  while (offset < bytes.length) {
    const field = readField(bytes, offset);
    if (!field) return null;
    offset = field.offset;

    if (field.fieldNumber === NODE_INFO_NUM && field.wireType === 0) {
      num = field.varintValue;
    } else if (field.fieldNumber === NODE_INFO_USER && field.wireType === 2 && field.bytes) {
      const user = decodeUser(field.bytes);
      if (!user) return null; // malformed nested message
      userId = user.id;
      longName = user.longName;
      shortName = user.shortName;
    }
  }

  const nodeId = normaliseNodeId(userId) ?? (num === null ? null : nodeIdFromNumber(num));
  if (!nodeId) return null;
  return { nodeId, longName, shortName };
}

/** Everything this module models from one `FromRadio` payload. */
interface DecodedFromRadio {
  nodeInfo: DeviceNodeInfo | null;
  position: DevicePosition | null;
  /** Last-known fix attached to a `NodeInfo` in the node database (stale). */
  lastKnownPosition: DevicePosition | null;
  configCompleteId: number | null;
}

/** Decodes a full `FromRadio` payload; `null` means malformed, not "no node". */
function decodeFromRadioMessage(payload: Uint8Array): DecodedFromRadio | null {
  const decoded: DecodedFromRadio = {
    nodeInfo: null,
    position: null,
    lastKnownPosition: null,
    configCompleteId: null,
  };
  let offset = 0;

  while (offset < payload.length) {
    const field = readField(payload, offset);
    if (!field) return null;
    offset = field.offset;

    if (field.fieldNumber === FROM_RADIO_NODE_INFO && field.wireType === 2 && field.bytes) {
      decoded.nodeInfo = decodeNodeInfo(field.bytes);
      // The database entry carries that node's last known position; without this
      // every remembered node stays invisible on the map.
      const lastKnown = decodeNodeInfoPosition(field.bytes);
      if (lastKnown && decoded.nodeInfo) {
        decoded.lastKnownPosition = { ...lastKnown, nodeId: decoded.nodeInfo.nodeId };
      }
    } else if (field.fieldNumber === FROM_RADIO_PACKET && field.wireType === 2 && field.bytes) {
      decoded.position = decodeMeshPacketPosition(field.bytes);
    } else if (
      field.fieldNumber === FROM_RADIO_CONFIG_COMPLETE_ID &&
      field.wireType === 0
    ) {
      decoded.configCompleteId = field.varintValue;
    }
    // Any other FromRadio variant (my_info, config, channel, …) is skipped.
  }
  return decoded;
}

/**
 * Reads `NodeInfo.position` (field 3) — the node's last known fix.
 *
 * A `NodeInfo` whose `Position` is the (0,0) placeholder yields `null`, so a node
 * that has never had a fix is simply not plotted.
 */
function decodeNodeInfoPosition(bytes: Uint8Array): DevicePosition | null {
  let offset = 0;
  while (offset < bytes.length) {
    const field = readField(bytes, offset);
    if (!field) return null;
    offset = field.offset;
    if (field.fieldNumber === NODE_INFO_POSITION && field.wireType === 2 && field.bytes) {
      return decodePositionMessage(field.bytes);
    }
  }
  return null;
}

/** Never throws: malformed protobuf simply yields `null`. */
function tryDecodeFromRadio(payload: Uint8Array): DecodedFromRadio | null {
  try {
    return decodeFromRadioMessage(payload);
  } catch {
    return null;
  }
}

/** Unsigned little-endian 32-bit (protobuf `fixed32`). */
function readFixed32U(bytes: Uint8Array): number {
  return ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0) as number;
}

/** Signed little-endian 32-bit (protobuf `sfixed32`). */
function readFixed32S(bytes: Uint8Array): number {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
}

/** Place values of the first five varint groups, within 32 bits. */
const LOW32_FACTORS = [1, 128, 16384, 2097152, 268435456];

/**
 * Reads a varint and returns its low 32 bits, sign-extended, computed exactly.
 *
 * Bytes past the fifth only contribute above bit 31, so they can be ignored —
 * which is what keeps the arithmetic exact where a float64 accumulation is not.
 */
function readVarintLow32(bytes: Uint8Array, offset: number): number | null {
  let accumulator = 0;
  let cursor = offset;
  let seen = 0;
  let terminated = false;

  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    cursor += 1;
    if (seen < LOW32_FACTORS.length) accumulator += (byte & 0x7f) * LOW32_FACTORS[seen];
    seen += 1;
    if ((byte & 0x80) === 0) {
      terminated = true;
      break;
    }
    if (seen > 10) return null; // longer than any legal varint
  }
  if (!terminated) return null;

  const low = accumulator % 4294967296;
  return low > 2147483647 ? low - 4294967296 : low;
}

/**
 * Reads a bare `Position` message.
 *
 * @returns `null` for a malformed message or one carrying the (0,0) "no fix"
 *          placeholder.
 */
function decodePositionMessage(payload: Uint8Array): DevicePosition | null {
  let latitudeI: number | null = null;
  let longitudeI: number | null = null;
  let altitude: number | null = null;
  let satellites: number | null = null;
  let time: number | null = null;
  let offset = 0;

  while (offset < payload.length) {
    const field = readField(payload, offset);
    if (!field) return null;
    offset = field.offset;
    if (field.fieldNumber === POSITION_LATITUDE_I && field.wireType === 5 && field.bytes) {
      latitudeI = readFixed32S(field.bytes);
    } else if (field.fieldNumber === POSITION_LONGITUDE_I && field.wireType === 5 && field.bytes) {
      longitudeI = readFixed32S(field.bytes);
    } else if (field.fieldNumber === POSITION_ALTITUDE && field.wireType === 0) {
      altitude = field.int32Value;
    } else if (field.fieldNumber === POSITION_TIME && field.wireType === 5 && field.bytes) {
      time = readFixed32U(field.bytes);
    } else if (field.fieldNumber === POSITION_SATS && field.wireType === 0) {
      satellites = field.varintValue;
    }
  }

  if (latitudeI === null || longitudeI === null) return null;
  // (0, 0) is the "no fix yet" placeholder, same rule as the text parser.
  if (latitudeI === 0 && longitudeI === 0) return null;

  return {
    nodeId: '', // filled in by the caller, which knows which node this belongs to
    latitude: latitudeI / LAT_LON_SCALE,
    longitude: longitudeI / LAT_LON_SCALE,
    altitude,
    satellites,
    time,
  };
}

/**
 * Decodes `FromRadio.packet` when it carries a position.
 *
 * Path: `MeshPacket.from` (node) → `Data.portnum == POSITION_APP` →
 * `Data.payload` → `Position{latitude_i, longitude_i, altitude, time}`.
 */
function decodeMeshPacketPosition(bytes: Uint8Array): DevicePosition | null {
  let from: number | null = null;
  let data: Uint8Array | null = null;
  let offset = 0;

  while (offset < bytes.length) {
    const field = readField(bytes, offset);
    if (!field) return null;
    offset = field.offset;
    if (field.fieldNumber === MESH_PACKET_FROM && field.wireType === 5 && field.bytes) {
      from = readFixed32U(field.bytes);
    } else if (field.fieldNumber === MESH_PACKET_DECODED && field.wireType === 2 && field.bytes) {
      data = field.bytes;
    }
  }
  if (from === null || !data) return null;

  let portnum: number | null = null;
  let payload: Uint8Array | null = null;
  offset = 0;
  while (offset < data.length) {
    const field = readField(data, offset);
    if (!field) return null;
    offset = field.offset;
    if (field.fieldNumber === DATA_PORTNUM && field.wireType === 0) {
      portnum = field.varintValue;
    } else if (field.fieldNumber === DATA_PAYLOAD && field.wireType === 2 && field.bytes) {
      payload = field.bytes;
    }
  }
  if (portnum !== PORTNUM_POSITION || !payload) return null;

  const decoded = decodePositionMessage(payload);
  if (!decoded) return null;
  const nodeId = nodeIdFromNumber(from);
  if (!nodeId) return null;

  return { ...decoded, nodeId };
}

/**
 * Minimal `FromRadio` reader: returns the position when the payload carries a
 * `MeshPacket` with a POSITION payload, else `null`. Exported for testing.
 */
export function decodeFromRadioPacket(payload: Uint8Array): DevicePosition | null {
  const decoded = tryDecodeFromRadio(payload);
  return decoded ? decoded.position : null;
}

/**
 * Minimal `FromRadio` reader: returns a `NodeInfo`'s last-known position when the
 * payload carries one, else `null`. Exported for testing.
 */
export function decodeFromRadioLastKnownPosition(payload: Uint8Array): DevicePosition | null {
  const decoded = tryDecodeFromRadio(payload);
  return decoded ? decoded.lastKnownPosition : null;
}

/**
 * Minimal `FromRadio` reader: returns the `NodeInfo` record when the payload
 * carries one, and `null` for anything else — including malformed input.
 *
 * Exported so the protobuf details can be tested directly.
 */
export function decodeFromRadio(payload: Uint8Array): DeviceNodeInfo | null {
  const decoded = tryDecodeFromRadio(payload);
  return decoded ? decoded.nodeInfo : null;
}

/* -------------------------------------------------------------------------- */
/* Streaming scanner                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Incremental scanner for a byte stream that interleaves ASCII firmware logs
 * with `0x94C3`-framed protobuf messages.
 *
 * Feed it every chunk from the port; it returns the leftover text plus any
 * decoded node records. Partial frames and partial text are kept between calls,
 * so a frame may be split at *any* byte boundary (including between `0x94` and
 * `0xC3`) and is still decoded exactly once.
 *
 * The scanner never throws. A `0x94 0xC3` pair inside log text whose declared
 * length exceeds {@link MAX_FRAME_LENGTH} is treated as text, and the internal
 * buffer is capped at {@link MAX_BUFFER_BYTES} (oldest bytes dropped) so memory
 * stays bounded whatever the device sends.
 */
export class MeshtasticStreamScanner {
  /** Bytes received but not yet consumed (a partial frame or a lone `0x94`). */
  private pending: number[] = [];

  /** Every node address this scanner has produced a name for. */
  private readonly namedNodes = new Set<string>();

  /** Discards any partially received frame/text. */
  reset(): void {
    this.pending = [];
    this.namedNodes.clear();
  }

  /** Feeds one chunk of serial bytes and returns everything decoded from it. */
  push(chunk: Uint8Array): ScanResult {
    const result: ScanResult = {
      text: '',
      nodeInfos: [],
      positions: [],
      lastKnownPositions: [],
      knownNodeNames: this.namedNodes.size,
      configComplete: false,
      droppedFrames: 0,
    };
    if (!chunk || chunk.length === 0) return result;

    // Enforce the memory cap up front too, so one absurd chunk cannot allocate
    // beyond it even transiently.
    const incoming =
      chunk.length > MAX_BUFFER_BYTES ? chunk.subarray(chunk.length - MAX_BUFFER_BYTES) : chunk;
    for (let i = 0; i < incoming.length; i += 1) this.pending.push(incoming[i]);
    if (this.pending.length > MAX_BUFFER_BYTES) {
      this.pending.splice(0, this.pending.length - MAX_BUFFER_BYTES);
    }

    this.consume(result);
    result.knownNodeNames = this.namedNodes.size;
    return result;
  }

  /**
   * Walks the pending buffer: bytes outside frames become text, complete frames
   * are decoded, and whatever is left (a partial frame, or a trailing `0x94`)
   * is retained for the next call.
   */
  private consume(result: ScanResult): void {
    const buffer = this.pending;
    const length = buffer.length;
    let index = 0;
    let textBytes: number[] = [];

    const flushText = (): void => {
      if (textBytes.length > 0) {
        result.text += decodeUtf8(Uint8Array.from(textBytes));
        textBytes = [];
      }
    };

    while (index < length) {
      if (buffer[index] !== START1) {
        textBytes.push(buffer[index]);
        index += 1;
        continue;
      }

      // A lone trailing 0x94 may be the first byte of a frame split across
      // pushes — keep it rather than spending it as text.
      if (index + 1 >= length) break;

      if (buffer[index + 1] !== START2) {
        textBytes.push(buffer[index]);
        index += 1;
        continue;
      }

      // Header needs 4 bytes; hold the fragment until the rest arrives.
      if (index + 3 >= length) break;

      const declared = (buffer[index + 2] << 8) | buffer[index + 3];
      if (declared > MAX_FRAME_LENGTH) {
        // Stray start marker inside log text: emit the 0x94 and keep scanning.
        textBytes.push(buffer[index]);
        index += 1;
        continue;
      }

      const frameEnd = index + 4 + declared;
      if (frameEnd > length) break; // wait for the payload

      flushText();
      const payload = Uint8Array.from(buffer.slice(index + 4, frameEnd));
      const decoded = tryDecodeFromRadio(payload);

      if (!decoded) {
        result.droppedFrames += 1;
      } else {
        if (decoded.nodeInfo) {
          result.nodeInfos.push(decoded.nodeInfo);
          this.namedNodes.add(decoded.nodeInfo.nodeId);
        }
        if (decoded.position) result.positions.push(decoded.position);
        if (decoded.lastKnownPosition) {
          result.lastKnownPositions.push(decoded.lastKnownPosition);
        }
        if (decoded.configCompleteId !== null) result.configComplete = true;
      }
      index = frameEnd;
    }

    flushText();
    this.pending = buffer.slice(index);
  }
}
