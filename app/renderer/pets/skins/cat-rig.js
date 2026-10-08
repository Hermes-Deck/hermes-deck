"use strict";
// The cats' shared rig (pets/skins/rig.js): one motion language, each cat only gives where its joints are.
// A cat acts like a cat: it sits for everything but sleep, taps the laptop's keys, brings a letter in its
// mouth, looks up at a "?", sleeps curled up with Zs rising. The tail rises free beside the body in two
// segments (the tip a child of the base, a beat behind it, so it bends); its root hides behind the body,
// and heads turn a few degrees at most, so no joint ever opens. Layers come from app/art/pet-<id>/rig/
// through make-pet-rig.py.
//
// at: canvas px of each pivot. head/tail1/tail2: per sitting scene ({idle, working, reply, waiting}); paws:
// [pawA, pawB] for working (the wrists: the top middle of each paw cut); q: the "?"; z: where the Zs rise from; sleep: the curled body's pivot.
(() => {
  const BLINK = { name: "blink", every: [3, 7], face: [["half", 50], ["closed", 120], ["half", 50]] };
  const face = (scene, names) => ({
    id: "face",
    faces: Object.fromEntries(["open", ...names].map((n) => [n, `${scene}-face-${n}`])),
  });
  const tail = (scene, at) => [
    { id: "tail1", img: `${scene}-tail1`, pivot: at.tail1[scene] },
    { id: "tail2", img: `${scene}-tail2`, pivot: at.tail2[scene], parent: "tail1" },
  ];
  const BODY = [240, 488];

  window.PetCatRig = (id, at) =>
    window.PetRig(id, `pets/${id}/`, {
      canvas: 512,
      scales: [1, 2, 3],
      look: { part: "head", x: 2.5, y: 1.5 },
      scenes: {
        idle: {
          pose: "sit",
          layers: [
            ...tail("idle", at),
            { id: "body", img: "idle-body", pivot: BODY },
            { id: "head", img: "idle-head", pivot: at.head.idle },
            { ...face("idle", ["half", "closed", "look"]), parent: "head" },
          ],
          loops: [{ part: "body", motion: "breathe", amp: 1.2, dur: 3800 }],
          acts: [
            BLINK,
            { name: "tilt", every: [10, 20], part: "head", motion: "tilt", amp: -3.5, dur: 2400 },
            { name: "glance", every: [12, 26], face: [["look", 1600]] },
            // a swish starts at the base; the tip follows a beat later, so the tail bends instead of folding
            { name: "swish", every: [5, 10], part: "tail1", motion: "flick", amp: 5, dur: 1300,
              with: [{ part: "tail2", motion: "flick", amp: 9, dur: 1300, delay: 170 }] },
          ],
        },
        working: {
          pose: "sit",
          layers: [
            { id: "body", img: "working-body", pivot: BODY },
            { id: "head", img: "working-head", pivot: at.head.working },
            { ...face("working", ["half", "closed"]), parent: "head" },
            { id: "pawA", img: "working-pawA", pivot: at.paws[0] },
            { id: "pawB", img: "working-pawB", pivot: at.paws[1] },
          ],
          loops: [
            // pivots at the wrists: a press lengthens the paw onto the key, nothing behind it shows
            { part: "pawA", motion: "press", amp: 3, dur: 380 },
            { part: "pawB", motion: "press", amp: 3, dur: 380, delay: 190 },
            { part: "body", motion: "breathe", amp: 1, dur: 3400 },
          ],
          acts: [BLINK, { name: "nod", every: [6, 12], part: "head", motion: "nod", amp: 2.5, dur: 900 }],
        },
        reply: {
          pose: "sit",
          layers: [
            ...tail("reply", at),
            { id: "body", img: "reply-body", pivot: BODY },
            { ...face("reply", ["closed"]), parent: "body" },
          ],
          loops: [
            { part: "tail1", motion: "sway", amp: 4, dur: 1100 },
            { part: "tail2", motion: "sway", amp: 13, dur: 1100, delay: 180 },
            { part: "body", motion: "breathe", amp: 1, dur: 3200 },
          ],
          acts: [
            { name: "smile", every: [4, 8], face: [["closed", 700]] },
            { name: "hop", every: [5, 10], part: "body", motion: "hop-small", amp: 4, dur: 520 },
          ],
        },
        waiting: {
          pose: "sit",
          layers: [
            ...tail("waiting", at),
            { id: "body", img: "waiting-body", pivot: BODY },
            { id: "head", img: "waiting-head", pivot: at.head.waiting },
            { ...face("waiting", ["half", "closed"]), parent: "head" },
            { id: "q", img: "waiting-q", pivot: at.q },
          ],
          loops: [
            { part: "q", motion: "bob", amp: 4, dur: 1100 },
            { part: "tail1", motion: "sway", amp: 3, dur: 2200 },
            { part: "tail2", motion: "sway", amp: 9, dur: 2200, delay: 350 },
            { part: "body", motion: "breathe", amp: 1, dur: 3400 },
          ],
          acts: [BLINK, { name: "tilt", every: [4, 9], part: "head", motion: "tilt", amp: 4.5, dur: 2000 }],
        },
        offline: {
          pose: "lie",
          layers: [
            { id: "body", img: "offline-body", pivot: at.sleep },
            // one "z" three times, rising from the nose one after another
            { id: "z1", img: "offline-z1", pivot: at.z },
            { id: "z2", img: "offline-z2", pivot: at.z },
            { id: "z3", img: "offline-z3", pivot: at.z },
          ],
          loops: [
            { part: "body", motion: "breathe", amp: 2.2, dur: 4600 },
            { part: "z1", motion: "drift", amp: 70, dur: 3600 },
            { part: "z2", motion: "drift", amp: 70, dur: 3600, delay: 1200 },
            { part: "z3", motion: "drift", amp: 70, dur: 3600, delay: 2400 },
          ],
          acts: [{ name: "shiver", every: [10, 20], part: "body", motion: "twitch", amp: 0.6, dur: 600 }],
        },
      },
    });
})();
