/**
 * Cross-source identity consistency.
 *
 * Three independent code paths produce a node key for the same device:
 *
 *  1. `parser.ts`      — position packets from the firmware log (`node=4058f711`)
 *  2. `nodeNames.ts`   — names from `Send owner …` / nodeinfo JSON
 *  3. `meshtasticProtocol.ts` — names from the device's node database (protobuf)
 *
 * If any two disagree — e.g. one pads to eight hex digits and another does not —
 * the same physical node appears TWICE: once as a named row and once as a bare
 * address, and its name never attaches to its trace. These tests pin the agreed
 * canonical form: lowercase, `!` prefix, no added padding.
 */
import { describe, expect, it } from 'vitest';
import { normaliseNodeId as normaliseProtoNodeId } from './meshtasticProtocol';
import { parseNodeIdentity } from './nodeNames';
import { parseSerialStreamLine } from './parser';

/**
 * Address spellings as the firmware actually writes them in TEXT log fields
 * (`node=…`, `fr=…`, `from=…`). Note there is no `!` here: the bang form only
 * appears in Meshtastic JSON, which is covered separately below.
 */
const LOG_ADDRESS_FORMS = [
  { raw: '4058f711', id: '!4058f711' },
  { raw: '4058F711', id: '!4058f711' },
  { raw: '0x4058f711', id: '!4058f711' },
  { raw: '8ce97125', id: '!8ce97125' },
];

describe('node identity agrees across every source', () => {
  for (const { raw, id } of LOG_ADDRESS_FORMS) {
    it(`"${raw}" resolves to ${id} in all three paths`, () => {
      // 3. protobuf node-database path
      expect(normaliseProtoNodeId(raw)).toBe(id);

      // 2. name-log path
      const identity = parseNodeIdentity(`INFO  | ??:??:?? 36 [NodeInfo] Send owner ${raw}/Name/SH`);
      expect(identity?.nodeId).toBe(id);

      // 1. position-parser path (the key traces and the map actually use)
      const point = parseSerialStreamLine(
        `DEBUG | 12:21:57 128 [Router] POSITION node=${raw} l=36 lat=386996426 lon=-92323358 msl=10`
      );
      expect(point?.node_id).toBe(id);
    });
  }

  it('the JSON "!" form agrees with the log form', () => {
    // Same device, two spellings: Meshtastic JSON uses "!4058f711", the text log
    // uses "4058f711". Both must key to one node.
    const fromJson = parseSerialStreamLine(
      'RX: {"from":"!4058f711","type":"position","payload":{"latitude_i":386996426,"longitude_i":-92323358}}'
    )?.node_id;
    const fromLog = parseSerialStreamLine(
      'DEBUG | 12:21:57 128 [Router] POSITION node=4058f711 l=36 lat=386996426 lon=-92323358 msl=10'
    )?.node_id;
    const fromNames = parseNodeIdentity('{"from":"!4058f711","type":"nodeinfo","payload":{"longName":"Lisboa Relay"}}')?.nodeId;
    const fromDatabase = normaliseProtoNodeId('!4058f711');

    expect(fromJson).toBe('!4058f711');
    expect(fromLog).toBe(fromJson);
    expect(fromNames).toBe(fromJson);
    expect(fromDatabase).toBe(fromJson);
  });

  it('the same node from the protobuf DB and from a position line share one key', () => {
    const fromDatabase = normaliseProtoNodeId('!4058f711');
    const fromPosition = parseSerialStreamLine(
      'DEBUG | 12:21:57 128 [Router] POSITION node=4058f711 l=36 lat=386996426 lon=-92323358 msl=10'
    )?.node_id;

    expect(fromDatabase).toBe(fromPosition);
  });

  it('the same node from a name log line and from a position line share one key', () => {
    const fromLog = parseNodeIdentity('DEBUG | 12:21:57 128 [Router] Update changed=1 user Lisboa/LIS, id=0x4058f711, channel=1');
    const fromPosition = parseSerialStreamLine(
      'DEBUG | 12:21:57 128 [Router] POSITION node=4058f711 l=36 lat=386996426 lon=-92323358 msl=10'
    )?.node_id;

    expect(fromLog?.nodeId).toBe(fromPosition);
  });
});
