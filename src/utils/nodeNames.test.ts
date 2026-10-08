import { describe, expect, it } from 'vitest';
import {
  displayLongName,
  displayName,
  mergeNodeIdentity,
  parseNodeIdentity,
  resolveNodeLabel,
  type NodeIdentityMap,
} from './nodeNames';

const ESC = '\u001b';

describe('firmware log identities', () => {
  it('parses the Send owner line from the field log', () => {
    const id = parseNodeIdentity(
      'INFO  | ??:??:?? 36 [NodeInfo] Send our nodeinfo to mesh (wantReplies=0)\u0000'
    );
    expect(id).toBeNull();
  });

  it('parses `Send owner <id>/<long>/<short>`', () => {
    const id = parseNodeIdentity('INFO  | ??:??:?? 36 [NodeInfo] Send owner !c931be04/Inov_Bas/####');
    expect(id).toEqual({ nodeId: '!c931be04', longName: 'Inov_Bas', shortName: '####' });
  });

  it('tolerates ANSI colours and the 0x prefix', () => {
    const id = parseNodeIdentity(
      `${ESC}[32mINFO  ${ESC}[0m| ??:??:?? 36 [NodeInfo] Send owner 0xc931be04/Inov_Bas/IB1`
    );
    expect(id?.nodeId).toBe('!c931be04');
    expect(id?.longName).toBe('Inov_Bas');
  });

  it('parses the `user <long>/<short>, id=0x…` update line', () => {
    const id = parseNodeIdentity(
      'DEBUG | 11:36:11 48 [Router] Update changed=1 user Meshtastic 7125/7125, id=0x8ce97125, channel=1'
    );
    expect(id).toEqual({ nodeId: '!8ce97125', longName: 'Meshtastic 7125', shortName: '7125' });
  });

  it('returns null for log lines that carry no name', () => {
    for (const line of [
      'DEBUG | ??:??:?? 11 [GPS] Publish pos@0:2, hasVal=0, Sats=0, GPSlock=0',
      'DEBUG | 11:36:11 48 [Router] Received nodeinfo from=0x8ce97125, id=0x23efcfb2, portnum=4',
      'INFO  | ??:??:?? 7 Radio freq=869.525, config.lora.frequency_offset=0.000',
      '',
      '   ',
    ]) {
      expect(parseNodeIdentity(line)).toBeNull();
    }
  });
});

describe('JSON identities', () => {
  it('parses the nodeinfo packet the simulator emits', () => {
    const id = parseNodeIdentity(
      '{"from":"!28a9df12","type":"nodeinfo","payload":{"id":"!28a9df12","longName":"Sim Ridge Relay","shortName":"SIM1"}}'
    );
    expect(id).toEqual({ nodeId: '!28a9df12', longName: 'Sim Ridge Relay', shortName: 'SIM1' });
  });

  it('parses a nested user object', () => {
    const id = parseNodeIdentity('{"payload":{"user":{"id":"!a1d7631c","longName":"Lisbon Relay","shortName":"LIS"}}}');
    expect(id).toEqual({ nodeId: '!a1d7631c', longName: 'Lisbon Relay', shortName: 'LIS' });
  });

  it('falls back to from/sender for the id', () => {
    expect(parseNodeIdentity('{"sender":"!deadbeef","longName":"Barn"}')?.nodeId).toBe('!deadbeef');
  });

  it('ignores JSON with no name', () => {
    expect(parseNodeIdentity('{"from":"!abc","type":"position","payload":{"latitude_i":1,"longitude_i":2}}')).toBeNull();
    expect(parseNodeIdentity('{"a":')).toBeNull();
  });
});

describe('merging identities', () => {
  it('adds a new identity and keeps the shape', () => {
    const map = mergeNodeIdentity({}, { nodeId: '!c931be04', longName: 'Inov_Bas', shortName: '####' });
    expect(map['!c931be04']).toEqual({ nodeId: '!c931be04', longName: 'Inov_Bas', shortName: '####' });
  });

  it('returns the same reference when nothing changed (React bail-out)', () => {
    const first = mergeNodeIdentity({}, { nodeId: '!a', longName: 'A', shortName: 'a' });
    const again = mergeNodeIdentity(first, { nodeId: '!a', longName: 'A', shortName: 'a' });
    expect(again).toBe(first);
  });

  it('does not erase a known name when a later packet has none', () => {
    const withName = mergeNodeIdentity({}, { nodeId: '!a', longName: 'Alpha', shortName: 'AL' });
    const nameless = mergeNodeIdentity(withName, { nodeId: '!a', longName: null, shortName: null });
    expect(nameless).toBe(withName);
    expect(nameless['!a'].longName).toBe('Alpha');
  });

  it('fills in a missing field from a later line', () => {
    let map: NodeIdentityMap = mergeNodeIdentity({}, { nodeId: '!a', longName: 'Alpha', shortName: null });
    map = mergeNodeIdentity(map, { nodeId: '!a', longName: null, shortName: 'AL' });
    expect(map['!a']).toEqual({ nodeId: '!a', longName: 'Alpha', shortName: 'AL' });
  });
});

describe('label resolution', () => {
  const map: NodeIdentityMap = {
    '!c931be04': { nodeId: '!c931be04', longName: 'Inov_Bas', shortName: 'IB1' },
    '!longonly': { nodeId: '!longonly', longName: 'Lisboa Relay', shortName: null },
    '!shortonly': { nodeId: '!shortonly', longName: null, shortName: 'LIS' },
  };

  it('prefers the Meshtastic SHORT name, then the long name', () => {
    // The device's own four-character name is what the user sees on the screen.
    expect(displayName('!c931be04', map)).toBe('IB1');
    expect(displayName('!shortonly', map)).toBe('LIS');
    expect(displayName('!longonly', map)).toBe('Lisboa Relay');
  });

  it('still exposes the long name for secondary text and tooltips', () => {
    expect(displayLongName('!c931be04', map)).toBe('Inov_Bas');
    expect(displayLongName('!shortonly', map)).toBeNull();
    expect(displayLongName('!unknown', map)).toBeNull();
  });

  it('falls back to the raw address when the node is unknown', () => {
    expect(displayName('!unknown', map)).toBeNull();
    expect(resolveNodeLabel('!unknown', map)).toBe('!unknown');
    expect(resolveNodeLabel('!c931be04', map)).toBe('IB1');
    expect(resolveNodeLabel('!c931be04', undefined)).toBe('!c931be04');
  });
});
