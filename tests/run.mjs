import assert from 'assert';
import { solveAssignments } from '../js/assignment.js';
import { createDemoService, STORAGE_KEY } from '../js/demo-service.js';
import crypto from 'crypto';
let passed = 0;
async function test(name, work) { await work(); passed++; console.log(`PASS ${name}`); }
const people = groups => groups.map((householdId, i) => ({ id: String(i + 1), householdId }));
function valid(participants, pairs) {
  assert.strictEqual(pairs.length, participants.length);
  assert.strictEqual(new Set(pairs.map(p => p.giverId)).size, participants.length);
  assert.strictEqual(new Set(pairs.map(p => p.recipientId)).size, participants.length);
  for (const pair of pairs) {
    assert.notStrictEqual(pair.giverId, pair.recipientId);
    assert.notStrictEqual(participants.find(p => p.id === pair.giverId).householdId, participants.find(p => p.id === pair.recipientId).householdId);
  }
}
await test('solver rejects empty, single, same household and duplicate IDs', () => {
  for (const groups of [[], ['a'], ['a', 'a'], ['a', 'a', 'a', 'b']]) assert.throws(() => solveAssignments(people(groups)));
  assert.throws(() => solveAssignments([{ id: 'x', householdId: 'a' }, { id: 'x', householdId: 'b' }]));
});
await test('solver creates complete cross-household draws without mutating inputs', () => {
  for (const groups of [['a', 'b'], ['a', 'a', 'b', 'b'], ['a', 'a', 'b', 'c', 'd'], Array.from({ length: 200 }, (_, i) => String(i % 5))]) {
    const input = people(groups); const before = JSON.stringify(input);
    for (let i = 0; i < 20; i++) valid(input, solveAssignments(input));
    assert.strictEqual(JSON.stringify(input), before);
  }
});
await test('exhaustive household distributions through 8 people agree with feasibility bound', () => {
  for (let n = 2; n <= 8; n++) {
    for (let code = 0; code < 3 ** n; code++) {
      let value = code; const groups = Array.from({ length: n }, () => { const group = String(value % 3); value = Math.floor(value / 3); return group; });
      const feasible = ['0', '1', '2'].every(h => groups.filter(g => g === h).length <= n / 2);
      if (feasible) valid(people(groups), solveAssignments(people(groups), () => 0.5));
      else assert.throws(() => solveAssignments(people(groups)));
    }
  }
});
function fixture() {
  const data = new Map(); const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const cryptoApi = { getRandomValues: bytes => crypto.randomFillSync(bytes) };
  return { data, storage, service: createDemoService(storage, cryptoApi) };
}
await test('household CRUD, duplicates, registration validation and locking', async () => {
  const { service: s } = fixture();
  await s.saveHousehold({ name: '  Maple   House ' }); const h = (await s.getEvent()).households[0]; assert.strictEqual(h.name, 'Maple House');
  await assert.rejects(s.saveHousehold({ name: 'maple house' }));
  await s.saveHousehold({ id: h.id, name: 'Maples' });
  await assert.rejects(s.join({ name: 'A', email: 'bad', householdId: h.id }));
  await assert.rejects(s.join({ name: 'A', email: 'a@test.com', householdId: 'missing' }));
  await s.join({ name: ' Alice ', email: 'ALICE@Test.com', householdId: h.id });
  await assert.rejects(s.join({ name: 'Other', email: 'alice@test.com', householdId: h.id }));
  await assert.rejects(s.join({ name: 'alice', email: 'other@test.com', householdId: h.id }));
  await assert.rejects(s.deleteHousehold(h.id)); await s.setLocked(true);
  await assert.rejects(s.join({ name: 'Bob', email: 'b@test.com', householdId: h.id }));
  const p = (await s.getEvent()).participants[0]; await s.removeParticipant(p.id); await s.deleteHousehold(h.id);
  assert.strictEqual((await s.getEvent()).households.length, 0);
});
await test('failed draws save nothing; successful draws freeze event and reset revokes tokens', async () => {
  const { service: s, data } = fixture();
  await s.saveHousehold({ name: 'A' }); await s.saveHousehold({ name: 'B' });
  const [a, b] = (await s.getEvent()).households;
  for (let i = 0; i < 3; i++) await s.join({ name: `Person ${i}`, email: `p${i}@test.com`, householdId: i < 2 ? a.id : b.id });
  await assert.rejects(s.generate()); await s.setLocked(true);
  const before = data.get(STORAGE_KEY); await assert.rejects(s.generate()); assert.strictEqual(data.get(STORAGE_KEY), before);
  await s.setLocked(false); await s.join({ name: 'Fourth', email: 'four@test.com', householdId: b.id }); await s.setLocked(true); await s.generate();
  const event = await s.getEvent(); assert.strictEqual(event.drawn, true); assert.ok(!('draw' in event));
  const links = await s.getRevealLinks(); assert.strictEqual(new Set(links.map(l => l.token)).size, 4);
  for (const link of links) { assert.match(link.token, /^[a-f0-9]{64}$/); const reveal = await s.reveal(link.token); assert.deepStrictEqual(Object.keys(reveal).sort(), ['participantName', 'recipientName']); assert.strictEqual(reveal.participantName, link.name); }
  await assert.rejects(s.reveal('invalid')); await assert.rejects(s.generate()); await assert.rejects(s.setLocked(false));
  await assert.rejects(s.saveHousehold({ name: 'C' })); await assert.rejects(s.removeParticipant(event.participants[0].id));
  await assert.rejects(s.reset('RESET')); await s.reset('RESET EVENT');
  await assert.rejects(s.reveal(links[0].token)); assert.strictEqual((await s.getEvent()).participants.length, 4); assert.strictEqual((await s.getEvent()).locked, false);
});
await test('corrupt storage and failed writes report errors without overwriting data', async () => {
  const { service: s, data, storage } = fixture(); data.set(STORAGE_KEY, '{bad'); await assert.rejects(s.getEvent()); assert.strictEqual(data.get(STORAGE_KEY), '{bad');
  data.delete(STORAGE_KEY); storage.setItem = () => { throw new Error('quota'); }; await assert.rejects(s.saveHousehold({ name: 'A' })); assert.strictEqual(data.has(STORAGE_KEY), false);
});
await test('secure randomness required; token collision cannot partially save a draw', async () => {
  const { storage, service: s, data } = fixture();
  await assert.rejects(createDemoService(storage, {}).saveHousehold({ name: 'A' }));
  await s.saveHousehold({ name: 'A' }); await s.saveHousehold({ name: 'B' }); const households = (await s.getEvent()).households;
  for (let i = 0; i < 2; i++) await s.join({ name: `P${i}`, email: `p${i}@test.com`, householdId: households[i].id });
  await s.setLocked(true); const before = data.get(STORAGE_KEY);
  const collisionService = createDemoService(storage, { getRandomValues: bytes => bytes.fill(1) });
  await assert.rejects(collisionService.generate()); assert.strictEqual(data.get(STORAGE_KEY), before);
});
console.log(`\n${passed} test groups passed.`);
