import { describe, expect, it } from 'vitest';
import {
  MAX_BUFFER_BYTES,
  MAX_FRAME_LENGTH,
  MeshtasticStreamScanner,
  decodeFromRadio,
  encodeWantConfigRequest,
  normaliseNodeId,
  readVarint,
} from './meshtasticProtocol';

/* -------------------------------------------------------------------------- */
/* Protobuf builders (hand-rolled on purpose: no protobuf library in tests)    */
/* -------------------------------------------------------------------------- */

function protoVarint(value: number): number[] {
  const out: number[] = [];
  let remaining = Math.floor(value);
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    out.push(remaining > 0 ? byte + 0x80 : byte);
  } while (remaining > 0);
  return out;
}

function tag(fieldNumber: number, wireType: number): number[] {
  return protoVarint((fieldNumber << 3) | wireType);
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...tag(fieldNumber, 0), ...protoVarint(value)];
}

function bytesField(fieldNumber: number, bytes: number[]): number[] {
  return [...tag(fieldNumber, 2), ...protoVarint(bytes.length), ...bytes];
}

function stringField(fieldNumber: number, text: string): number[] {
  return bytesField(fieldNumber, Array.from(new TextEncoder().encode(text)));
}

function fixed64Field(fieldNumber: number, value: number): number[] {
  const out = tag(fieldNumber, 1);
  let remaining = Math.max(0, Math.floor(value));
  for (let i = 0; i < 8; i += 1) {
    out.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

function fixed32Field(fieldNumber: number, value: number): number[] {
  const out = tag(fieldNumber, 5);
  let remaining = Math.max(0, Math.floor(value));
  for (let i = 0; i < 4; i += 1) {
    out.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

interface NodeInfoParts {
  num?: number;
  id?: string;
  longName?: string;
  shortName?: string;
}

function userBytes(parts: NodeInfoParts): number[] {
  const out: number[] = [];
  if (parts.id !== undefined) out.push(...stringField(1, parts.id));
  if (parts.longName !== undefined) out.push(...stringField(2, parts.longName));
  if (parts.shortName !== undefined) out.push(...stringField(3, parts.shortName));
  return out;
}

function nodeInfoBytes(parts: NodeInfoParts): number[] {
  const out: number[] = [];
  if (parts.num !== undefined) out.push(...varintField(1, parts.num));
  if (parts.id !== undefined || parts.longName !== undefined || parts.shortName !== undefined) {
    out.push(...bytesField(2, userBytes(parts)));
  }
  return out;
}

/** A realistic `FromRadio { node_info { … } }` payload, without the framing. */
function fromRadioNodeInfoBytes(parts: NodeInfoParts): number[] {
  return bytesField(4, nodeInfoBytes(parts));
}

function frameBytes(payload: number[]): Uint8Array {
  return Uint8Array.from([
    0x94,
    0xc3,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
  ]);
}

/** A complete `0x94C3` frame carrying one `FromRadio.node_info`. */
function nodeInfoFrame(parts: NodeInfoParts): Uint8Array {
  return frameBytes(fromRadioNodeInfoBytes(parts));
}

/** A complete `0x94C3` frame carrying `FromRadio.config_complete_id`. */
function configCompleteFrame(id = 1): Uint8Array {
  return frameBytes(varintField(7, id));
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(Array.from(text).map((char) => char.charCodeAt(0)));
}

const RELAIS: NodeInfoParts = {
  num: 0x4058f711,
  id: '!4058f711',
  longName: 'Café Relais',
  shortName: 'CR1',
};

/* -------------------------------------------------------------------------- */
/* encodeWantConfigRequest                                                     */
/* -------------------------------------------------------------------------- */

describe('encodeWantConfigRequest', () => {
  it('produces the exact want_config_id frame for the default id', () => {
    // 0x18 = (3 << 3) | 0, then 0x01.
    expect(Array.from(encodeWantConfigRequest())).toEqual([0x94, 0xc3, 0x00, 0x02, 0x18, 0x01]);
  });

  it('treats an explicit id of 1 as the default', () => {
    expect(Array.from(encodeWantConfigRequest(1))).toEqual(
      Array.from(encodeWantConfigRequest())
    );
  });

  it('encodes a multi-byte id and fixes up the big-endian length', () => {
    // 300 -> varint 0xAC 0x02, payload [0x18, 0xAC, 0x02] -> length 3.
    expect(Array.from(encodeWantConfigRequest(300))).toEqual([
      0x94, 0xc3, 0x00, 0x03, 0x18, 0xac, 0x02,
    ]);
  });

  it('encodes a three-byte id', () => {
    // 70000 -> varint 0xF0 0xA2 0x04, payload length 4.
    expect(Array.from(encodeWantConfigRequest(70000))).toEqual([
      0x94, 0xc3, 0x00, 0x04, 0x18, 0xf0, 0xa2, 0x04,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* readVarint                                                                  */
/* -------------------------------------------------------------------------- */

describe('readVarint', () => {
  it('reads a single-byte varint and reports the next offset', () => {
    expect(readVarint(Uint8Array.from([0x18]), 0)).toEqual({ value: 24, offset: 1 });
    expect(readVarint(Uint8Array.from([0x00, 0x96, 0x01]), 1)).toEqual({ value: 150, offset: 3 });
  });

  it('reads a two-byte varint', () => {
    expect(readVarint(Uint8Array.from([0x80, 0x01]), 0)).toEqual({ value: 128, offset: 2 });
  });

  it('reads the uint32 maximum without wrapping', () => {
    expect(readVarint(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]), 0)).toEqual({
      value: 4294967295,
      offset: 5,
    });
  });

  it('is safe past 32 bits (no bitwise truncation)', () => {
    const encoded = protoVarint(2 ** 40); // 1 099 511 627 776
    const read = readVarint(Uint8Array.from(encoded), 0);
    expect(read?.value).toBe(2 ** 40);
    expect(read?.offset).toBe(encoded.length);
  });

  it('reads Number.MAX_SAFE_INTEGER exactly from a 10-byte-capable varint', () => {
    const encoded = protoVarint(Number.MAX_SAFE_INTEGER);
    expect(encoded.length).toBe(8);
    expect(readVarint(Uint8Array.from(encoded), 0)?.value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns null for a truncated varint', () => {
    expect(readVarint(Uint8Array.from([0x80]), 0)).toBeNull();
    expect(readVarint(Uint8Array.from([0x80, 0x80]), 0)).toBeNull();
  });

  it('returns null for an over-long (more than 10 byte) varint', () => {
    const overlong = new Uint8Array(11).fill(0x80);
    expect(readVarint(overlong, 0)).toBeNull();
  });

  it('returns null for an offset outside the buffer', () => {
    expect(readVarint(Uint8Array.from([]), 0)).toBeNull();
    expect(readVarint(Uint8Array.from([0x01]), 1)).toBeNull();
    expect(readVarint(Uint8Array.from([0x01]), -1)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* decodeFromRadio                                                             */
/* -------------------------------------------------------------------------- */

describe('decodeFromRadio', () => {
  it('decodes a realistic node_info record', () => {
    const node = decodeFromRadio(Uint8Array.from(fromRadioNodeInfoBytes(RELAIS)));
    expect(node).toEqual({
      nodeId: '!4058f711',
      longName: 'Café Relais',
      shortName: 'CR1',
    });
  });

  it('decodes non-ASCII names as UTF-8', () => {
    const node = decodeFromRadio(
      Uint8Array.from(fromRadioNodeInfoBytes({ id: '!4058f711', longName: 'Café Relais' }))
    );
    expect(node?.longName).toBe('Café Relais');
    expect(node?.longName).toHaveLength(11);
    expect(node?.longName?.codePointAt(3)).toBe(0xe9); // é
    expect(node?.shortName).toBeNull();
  });

  it('yields null names for a NodeInfo that only has num', () => {
    const node = decodeFromRadio(Uint8Array.from(fromRadioNodeInfoBytes({ num: 0x4058f711 })));
    expect(node).toEqual({ nodeId: '!4058f711', longName: null, shortName: null });
  });

  it('falls back to num when user.id is missing or unusable', () => {
    const noId = decodeFromRadio(
      Uint8Array.from(fromRadioNodeInfoBytes({ num: 0x4058f711, longName: 'No Id' }))
    );
    expect(noId?.nodeId).toBe('!4058f711');
    expect(noId?.longName).toBe('No Id');

    const badId = decodeFromRadio(
      Uint8Array.from(fromRadioNodeInfoBytes({ num: 16, id: 'not-a-node-id' }))
    );
    expect(badId?.nodeId).toBe('!00000010');
  });

  it('returns null when there is neither a usable id nor a num', () => {
    expect(
      decodeFromRadio(Uint8Array.from(fromRadioNodeInfoBytes({ longName: 'Nameless' })))
    ).toBeNull();
    expect(decodeFromRadio(Uint8Array.from(fromRadioNodeInfoBytes({})))).toBeNull();
  });

  it.each(['!4058f711', '0x4058f711', '4058f711', '!4058F711', '0X4058F711', ' !4058F711 '])(
    'normalises the user id %s to a canonical address',
    (raw) => {
      const node = decodeFromRadio(
        Uint8Array.from(fromRadioNodeInfoBytes({ id: raw, longName: 'Upper' }))
      );
      expect(node?.nodeId).toBe('!4058f711');
    }
  );

  it('skips unknown fields of every supported wire type', () => {
    const payload = [
      ...varintField(1, 7), // wire type 0
      ...fixed64Field(6, 123456789), // wire type 1
      ...bytesField(9, [1, 2, 3, 4, 5]), // wire type 2
      ...fixed32Field(11, 42), // wire type 5
      ...fromRadioNodeInfoBytes(RELAIS),
      ...varintField(12, 99), // trailing unknown field
    ];
    const node = decodeFromRadio(Uint8Array.from(payload));
    expect(node?.nodeId).toBe('!4058f711');
    expect(node?.longName).toBe('Café Relais');
    expect(node?.shortName).toBe('CR1');
  });

  it('returns null for malformed protobuf instead of throwing', () => {
    // Truncated varint inside the tag.
    expect(decodeFromRadio(Uint8Array.from([0x80]))).toBeNull();
    // Truncated varint as a field value.
    expect(decodeFromRadio(Uint8Array.from([0x08, 0x80]))).toBeNull();
    // Length-delimited field whose length runs past the end.
    expect(decodeFromRadio(Uint8Array.from([0x22, 0x05, 0x01]))).toBeNull();
    // Length-delimited field with a truncated length varint.
    expect(decodeFromRadio(Uint8Array.from([0x22, 0x80]))).toBeNull();
    // Fixed32/fixed64 that do not fit.
    expect(decodeFromRadio(Uint8Array.from([...tag(1, 5), 0x01, 0x02]))).toBeNull();
    expect(decodeFromRadio(Uint8Array.from([...tag(1, 1), 0x01]))).toBeNull();
  });

  it('rejects reserved/group wire types and field number 0', () => {
    expect(decodeFromRadio(Uint8Array.from([...tag(4, 7)]))).toBeNull();
    expect(decodeFromRadio(Uint8Array.from([...tag(4, 3), 0x00]))).toBeNull();
    expect(decodeFromRadio(Uint8Array.from([0x00]))).toBeNull();
  });

  it('propagates malformed nested messages', () => {
    // NodeInfo whose user sub-message declares a 1-byte string but ends early.
    expect(decodeFromRadio(Uint8Array.from(bytesField(4, bytesField(2, [0x0a]))))).toBeNull();
  });

  it('returns null when the payload carries no node_info', () => {
    expect(decodeFromRadio(Uint8Array.from([]))).toBeNull();
    expect(decodeFromRadio(Uint8Array.from(varintField(7, 5)))).toBeNull();
    expect(decodeFromRadio(Uint8Array.from(varintField(1, 5)))).toBeNull();
  });

  it('ignores the other NodeInfo fields a real device sends', () => {
    // A real NodeInfo also carries position(3), snr(4, fixed32), last_heard(5),
    // device_metrics(6), channel(7), hops_away(8) and is_favorite(9).
    const richNodeInfo = [
      ...varintField(1, 0x4058f711), // num
      ...bytesField(2, userBytes(RELAIS)), // user
      ...bytesField(3, [0x08, 0x01]), // position (nested, unmodelled)
      ...fixed32Field(4, 0x3f800000), // snr: 1.0f
      ...varintField(5, 1740000000), // last_heard
      ...bytesField(6, [0x08, 0x64]), // device_metrics (nested)
      ...varintField(7, 0), // channel
      ...varintField(8, 2), // hops_away
      ...varintField(9, 1), // is_favorite
    ];
    const node = decodeFromRadio(Uint8Array.from(bytesField(4, richNodeInfo)));
    expect(node).toEqual({ nodeId: '!4058f711', longName: 'Café Relais', shortName: 'CR1' });

    const scanned = new MeshtasticStreamScanner().push(
      frameBytes(bytesField(4, richNodeInfo))
    );
    expect(scanned.droppedFrames).toBe(0);
    expect(scanned.nodeInfos[0].longName).toBe('Café Relais');
  });
});

/* -------------------------------------------------------------------------- */
/* normaliseNodeId                                                             */
/* -------------------------------------------------------------------------- */

describe('normaliseNodeId', () => {
  it('pads short ids and lowercases', () => {
    expect(normaliseNodeId('58f711')).toBe('!0058f711');
    expect(normaliseNodeId('!A')).toBe('!0000000a');
  });

  it('rejects anything that is not 1-8 hex digits', () => {
    expect(normaliseNodeId('')).toBeNull();
    expect(normaliseNodeId('123456789')).toBeNull();
    expect(normaliseNodeId('zz')).toBeNull();
    expect(normaliseNodeId(null)).toBeNull();
    expect(normaliseNodeId(undefined)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* MeshtasticStreamScanner                                                     */
/* -------------------------------------------------------------------------- */

describe('MeshtasticStreamScanner framing', () => {
  it('decodes a frame split at every possible byte boundary exactly once', () => {
    const frame = nodeInfoFrame({ num: 0x4058f711, longName: 'Split Node', shortName: 'SPL' });
    for (let split = 0; split < frame.length; split += 1) {
      const scanner = new MeshtasticStreamScanner();
      const first = scanner.push(frame.subarray(0, split));
      const second = scanner.push(frame.subarray(split));
      expect(first.nodeInfos).toHaveLength(0);
      expect(second.nodeInfos).toHaveLength(1);
      expect(second.nodeInfos[0].longName).toBe('Split Node');
      expect(first.text + second.text).toBe('');
    }
  });

  it('keeps a trailing lone 0x94 for the next chunk', () => {
    const scanner = new MeshtasticStreamScanner();
    const frame = nodeInfoFrame(RELAIS);
    const first = scanner.push(frame.subarray(0, 1)); // just 0x94
    expect(first.text).toBe('');
    expect(first.nodeInfos).toHaveLength(0);
    const second = scanner.push(frame.subarray(1));
    expect(second.text).toBe('');
    expect(second.nodeInfos).toHaveLength(1);
    expect(second.nodeInfos[0].nodeId).toBe('!4058f711');
  });

  it('decodes several frames from one chunk, in order', () => {
    const chunk = Uint8Array.from([
      ...nodeInfoFrame({ num: 1, longName: 'Alpha', shortName: 'A' }),
      ...nodeInfoFrame({ num: 2, longName: 'Bravo', shortName: 'B' }),
      ...nodeInfoFrame({ num: 3, longName: 'Charlie', shortName: 'C' }),
    ]);
    const result = new MeshtasticStreamScanner().push(chunk);
    expect(result.nodeInfos.map((node) => node.longName)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(result.nodeInfos.map((node) => node.nodeId)).toEqual([
      '!00000001',
      '!00000002',
      '!00000003',
    ]);
    expect(result.text).toBe('');
    expect(result.droppedFrames).toBe(0);
  });

  it('returns surrounding log text intact and in order', () => {
    const scanner = new MeshtasticStreamScanner();
    const result = scanner.push(
      Uint8Array.from([
        ...ascii('INFO boot\n'),
        ...nodeInfoFrame(RELAIS),
        ...ascii('Node up\n'),
        ...nodeInfoFrame({ num: 2, longName: 'Bravo', shortName: 'B' }),
        ...ascii('done\n'),
      ])
    );
    expect(result.text).toBe('INFO boot\nNode up\ndone\n');
    expect(result.nodeInfos).toHaveLength(2);
    expect(result.nodeInfos[1].nodeId).toBe('!00000002');
  });

  it('decodes a node_info frame that arrives with other FromRadio frames', () => {
    const scanner = new MeshtasticStreamScanner();
    const first = scanner.push(nodeInfoFrame(RELAIS));
    expect(first.nodeInfos[0].shortName).toBe('CR1');
    expect(first.configComplete).toBe(false);

    const second = scanner.push(configCompleteFrame(7));
    expect(second.nodeInfos).toHaveLength(0);
    expect(second.configComplete).toBe(true);
  });

  it('detects config_complete_id even when it shares a chunk with node_info', () => {
    const result = new MeshtasticStreamScanner().push(
      Uint8Array.from([...nodeInfoFrame(RELAIS), ...configCompleteFrame(99)])
    );
    expect(result.configComplete).toBe(true);
    expect(result.nodeInfos).toHaveLength(1);
  });

  it('does not report configComplete for a node_info-only dump', () => {
    const result = new MeshtasticStreamScanner().push(nodeInfoFrame(RELAIS));
    expect(result.configComplete).toBe(false);
  });

  it('reassembles a whole interleaved dump fed one byte at a time', () => {
    const stream = Uint8Array.from([
      ...ascii('INFO boot\n'),
      ...nodeInfoFrame({ num: 0x4058f711, longName: 'Café Relais', shortName: 'CR1' }),
      ...ascii('DEBUG heartbeat\n'),
      ...nodeInfoFrame({ num: 0x28a9df12, longName: 'Sim Ridge Relay', shortName: 'SIM1' }),
      ...configCompleteFrame(3),
    ]);

    const scanner = new MeshtasticStreamScanner();
    let text = '';
    const names: string[] = [];
    let complete = false;
    for (const byte of stream) {
      const result = scanner.push(Uint8Array.from([byte]));
      text += result.text;
      names.push(...result.nodeInfos.map((node) => node.longName ?? ''));
      if (result.configComplete) complete = true;
    }

    expect(text).toBe('INFO boot\nDEBUG heartbeat\n');
    expect(names).toEqual(['Café Relais', 'Sim Ridge Relay']);
    expect(complete).toBe(true);
  });
});

describe('MeshtasticStreamScanner text handling', () => {
  it('keeps a partial text line across chunks', () => {
    const scanner = new MeshtasticStreamScanner();
    const first = scanner.push(ascii('INFO Send owner !40'));
    expect(first.text).toBe('INFO Send owner !40');
    expect(first.nodeInfos).toHaveLength(0);

    const second = scanner.push(ascii('58f711/Relais/CR1\r\n'));
    expect(second.text).toBe('58f711/Relais/CR1\r\n');

    const third = scanner.push(nodeInfoFrame(RELAIS));
    expect(third.text).toBe('');
    expect(third.nodeInfos).toHaveLength(1);
  });

  it('emits a lone 0x94 that turns out not to start a frame', () => {
    const scanner = new MeshtasticStreamScanner();
    const first = scanner.push(Uint8Array.from([...ascii('a'), 0x94]));
    expect(first.text).toBe('a');
    const second = scanner.push(ascii('x'));
    expect(second.text).toBe('\uFFFDx'); // the stray byte decodes to U+FFFD
  });

  it('returns empty results for an empty chunk and never throws', () => {
    const result = new MeshtasticStreamScanner().push(new Uint8Array(0));
    expect(result).toEqual({
      text: '',
      nodeInfos: [],
      positions: [],
      lastKnownPositions: [],
      knownNodeNames: 0,
      configComplete: false,
      droppedFrames: 0,
    });
  });

  it('drops a partial frame on reset()', () => {
    const scanner = new MeshtasticStreamScanner();
    const frame = nodeInfoFrame(RELAIS);
    scanner.push(frame.subarray(0, 6));
    scanner.reset();
    const result = scanner.push(frame.subarray(6));
    expect(result.nodeInfos).toHaveLength(0);
    expect(result.text.length).toBeGreaterThan(0); // the tail is now just log noise
  });
});

describe('MeshtasticStreamScanner robustness', () => {
  it('treats an absurd declared length as text instead of swallowing the stream', () => {
    const bogusHeader = [
      0x94,
      0xc3,
      ((MAX_FRAME_LENGTH + 1) >> 8) & 0xff,
      (MAX_FRAME_LENGTH + 1) & 0xff,
    ];
    const scanner = new MeshtasticStreamScanner();
    const result = scanner.push(
      Uint8Array.from([...ascii('before'), ...bogusHeader, ...ascii('after')])
    );
    expect(result.text.startsWith('before')).toBe(true);
    expect(result.text.endsWith('after')).toBe(true);
    expect(result.nodeInfos).toHaveLength(0);
    expect(result.droppedFrames).toBe(0);
  });

  it('still decodes a real frame that follows a stray absurd marker', () => {
    const bogusHeader = [0x94, 0xc3, 0xff, 0xff];
    const scanner = new MeshtasticStreamScanner();
    const result = scanner.push(
      Uint8Array.from([
        ...ascii('junk'),
        ...bogusHeader,
        ...ascii('junk'),
        ...nodeInfoFrame(RELAIS),
      ])
    );
    expect(result.nodeInfos).toHaveLength(1);
    expect(result.nodeInfos[0].longName).toBe('Café Relais');
    expect(result.text.startsWith('junk')).toBe(true);
  });

  it('counts a malformed frame and keeps decoding the next one', () => {
    const broken = frameBytes([0x22, 0x80]); // node_info with a truncated length varint
    const scanner = new MeshtasticStreamScanner();
    const result = scanner.push(
      Uint8Array.from([...ascii('log'), ...broken, ...nodeInfoFrame(RELAIS)])
    );
    expect(result.droppedFrames).toBe(1);
    expect(result.text).toBe('log');
    expect(result.nodeInfos).toHaveLength(1);
  });

  it('does not count a well-formed frame with only unknown fields as dropped', () => {
    const result = new MeshtasticStreamScanner().push(frameBytes(varintField(1, 5)));
    expect(result.droppedFrames).toBe(0);
    expect(result.nodeInfos).toHaveLength(0);
    expect(result.configComplete).toBe(false);
  });

  it('bounds the retained buffer, dropping the oldest bytes', () => {
    const frame = nodeInfoFrame(RELAIS);
    const chunk = Uint8Array.from([...new Array(MAX_BUFFER_BYTES + 500).fill(0x61), ...frame]);
    const result = new MeshtasticStreamScanner().push(chunk);
    expect(result.nodeInfos).toHaveLength(1);
    expect(result.text.length).toBe(MAX_BUFFER_BYTES - frame.length);
    expect(result.text.startsWith('aaa')).toBe(true);
  });
});
