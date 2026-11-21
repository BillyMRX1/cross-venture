// Adversarial rules acceptance for the REAL ../../firestore.rules, run against the
// local Firestore+Auth emulator only (demo project, no secrets, no live cloud).
// Uses @firebase/rules-unit-testing v6; legacy-doc seeding goes through
// withSecurityRulesDisabled (models pre-enforcement data).
// One-command rerun: ./run.sh (see that file's safety pins; missing tools = FAIL, never fake PASS).
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const PROJECT = 'demo-cv-rules';
if (!PROJECT.startsWith('demo-')) {
  console.error('SAFETY: harness project must be a demo-* id; refusing');
  process.exit(2);
}
const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
if (!rules.includes('match /workspaces/{wsId}')) {
  console.error('SAFETY: rules file does not look like the workspaces contract; refusing');
  process.exit(2);
}

const host = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
if (!/^127\.0\.0\.1:8080$|^localhost:8080$/.test(host)) {
  console.error(`SAFETY: emulator host ${host} is not loopback:8080; refusing`);
  process.exit(2);
}
process.env.FIRESTORE_EMULATOR_HOST = host;
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';

const envelope = (wsId, uid, extra = {}) => ({
  wsId,
  ownerUid: uid,
  iv: 'aWYWdleU5lcg==',
  cipher: 'Y2lwaGVyLWJ5dGVz',
  updatedAt: Date.now(),
  ...extra,
});

let pass = 0, fail = 0;
async function check(name, promise, shouldSucceed) {
  try {
    if (shouldSucceed) { await assertSucceeds(promise); } else { await assertFails(promise); }
    pass++; console.log(`PASS  ${name}`);
  } catch (e) {
    fail++; console.log(`FAIL  ${name} :: ${e?.code || e?.message || e}`);
  }
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules, host: 'localhost', port: 8080 },
  });

  // legacy doc without ownerUid (seeded with rules disabled: models pre-enforcement data)
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'workspaces', 'ws-legacy'), { wsId: 'ws-legacy', iv: 'x', cipher: 'y', updatedAt: 1 });
  });

  const anon = testEnv.unauthenticatedContext();
  const alice = testEnv.authenticatedContext('alice');
  const bob = testEnv.authenticatedContext('bob');

  const d = (ctx, id) => doc(ctx.firestore(), 'workspaces', id);

  // --- unauthenticated
  await check('anon get', getDoc(d(anon, 'ws-legacy')), false);
  await check('anon create', setDoc(d(anon, 'ws-a'), envelope('ws-a', 'nobody')), false);
  await check('anon list', getDocs(collection(anon.firestore(), 'workspaces')), false);

  // --- owner normal flow
  await check('alice create own valid doc', setDoc(d(alice, 'ws-1'), envelope('ws-1', 'alice')), true);
  await check('alice update own (ownerUid unchanged)', updateDoc(d(alice, 'ws-1'), { updatedAt: Date.now() + 1 }), true);
  await check('alice delete own', deleteDoc(d(alice, 'ws-1')), true);

  // --- deliberate read capability (pairing)
  await assertSucceeds(setDoc(d(alice, 'ws-2'), envelope('ws-2', 'alice')));
  await check('bob GET alice doc by known id', getDoc(d(bob, 'ws-2')), true);

  // --- foreign user cannot mutate
  await check('bob update alice doc', updateDoc(d(bob, 'ws-2'), { updatedAt: 999 }), false);
  await check('bob overwrite alice doc (setDoc)', setDoc(d(bob, 'ws-2'), envelope('ws-2', 'bob')), false);
  await check('bob delete alice doc', deleteDoc(d(bob, 'ws-2')), false);

  // --- no claiming / spoofing
  await check('bob create doc claiming ownerUid=alice', setDoc(d(bob, 'ws-3'), envelope('ws-3', 'alice')), false);
  await check('alice change ownerUid to bob', updateDoc(d(alice, 'ws-2'), { ownerUid: 'bob' }), false);

  // --- list denied even for owner
  await check('alice list collection', getDocs(collection(alice.firestore(), 'workspaces')), false);

  // --- malformed envelopes
  await check('create missing ownerUid', setDoc(d(alice, 'ws-m1'), { wsId: 'ws-m1', iv: 'x', cipher: 'y', updatedAt: Date.now() }), false);
  await check('create extra plaintext field', setDoc(d(alice, 'ws-m2'), { ...envelope('ws-m2', 'alice'), tokenMap: { PARTNER_1: 'Secret Corp' } }), false);
  await check('create key material field', setDoc(d(alice, 'ws-m3'), { ...envelope('ws-m3', 'alice'), key: 'JWK' }), false);
  await check('create wsId mismatch path', setDoc(d(alice, 'ws-m4'), envelope('ws-OTHER', 'alice')), false);
  await check('create empty iv', setDoc(d(alice, 'ws-m5'), { ...envelope('ws-m5', 'alice'), iv: '' }), false);
  await check('create empty cipher', setDoc(d(alice, 'ws-m6'), { ...envelope('ws-m6', 'alice'), cipher: '' }), false);
  await check('create updatedAt string', setDoc(d(alice, 'ws-m7'), { ...envelope('ws-m7', 'alice'), updatedAt: 'now' }), false);
  await check('create bad id (space)', setDoc(d(alice, 'ws bad'), envelope('ws bad', 'alice')), false);
  await check('create oversized cipher', setDoc(d(alice, 'ws-m8'), { ...envelope('ws-m8', 'alice'), cipher: 'A'.repeat(900_001) }), false);

  // --- legacy doc: readable by any authenticated, never claimable/mutable
  await check('bob GET legacy doc (pairing read)', getDoc(d(bob, 'ws-legacy')), true);
  await check('bob claim legacy (update)', updateDoc(d(bob, 'ws-legacy'), { ownerUid: 'bob' }), false);
  await check('bob overwrite legacy (setDoc)', setDoc(d(bob, 'ws-legacy'), envelope('ws-legacy', 'bob')), false);
  await check('bob delete legacy', deleteDoc(d(bob, 'ws-legacy')), false);

  await testEnv.cleanup();
  console.log(`\nRESULT ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
