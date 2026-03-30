// rtc.js — WebRTC peer connection lifecycle (TURN-only, no IP leaks)
// Adapted from seaof.glass/share/js/rtc.js

const ICE_GATHER_TIMEOUT = 5000; // 5s — TURN relay candidates take longer

const TURN_CONFIG = {
  iceServers: [{
    urls: [
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }],
  iceTransportPolicy: 'relay' // TURN only — no host/srflx candidates
};

let _log = () => {};
export function setRtcLogger(fn) { _log = fn; }

export function createPeerConnection(onStateChange) {
  const pc = new RTCPeerConnection(TURN_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      _log(`ice candidate: ${e.candidate.type || 'relay'}`);
    } else {
      _log('ice gathering complete');
    }
  };

  if (onStateChange) {
    pc.onconnectionstatechange = () => onStateChange('connection', pc.connectionState);
    pc.oniceconnectionstatechange = () => onStateChange('ice', pc.iceConnectionState);
  }

  return pc;
}

export function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      _log('ice gathering timed out — proceeding with partial candidates');
      resolve();
    }, ICE_GATHER_TIMEOUT);

    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
  });
}

export async function createOffer(pc) {
  const dc = pc.createDataChannel('quartz', { ordered: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  return { dataChannel: dc, sdp: JSON.stringify(pc.localDescription) };
}

export async function createAnswer(pc, offerSdp) {
  const offer = JSON.parse(offerSdp);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);
  return JSON.stringify(pc.localDescription);
}

export async function acceptAnswer(pc, answerSdp) {
  const answer = JSON.parse(answerSdp);
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export function onDataChannel(pc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('DataChannel timed out — peer may be unreachable'));
    }, 30000);
    pc.ondatachannel = (e) => {
      clearTimeout(timeout);
      resolve(e.channel);
    };
  });
}

export function waitForOpen(dc) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error('DataChannel open timed out'));
    }, 30000);
    dc.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    dc.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`DataChannel error: ${e.error?.message || 'unknown'}`));
    };
  });
}
