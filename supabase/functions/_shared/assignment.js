/** Randomized augmenting-path backtracking for a bipartite perfect matching.
 * Each search visits each recipient at most once; runtime is O(n^3), not retries.
 * Returns a complete list or throws without mutating the input.
 */
export function solveAssignments(participants, random = Math.random) {
  const n = participants.length;
  if (n < 2) throw new Error('At least two participants in different households are needed.');
  if (new Set(participants.map(p => p.id)).size !== n || participants.some(p => !p.id || !p.householdId)) {
    throw new Error('Participants must have unique IDs and a household.');
  }
  const choices = participants.map(giver => participants.map((p, i) => ({ p, i }))
    .filter(({ p }) => p.id !== giver.id && p.householdId !== giver.householdId).map(({ i }) => i));
  for (const list of choices) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const owners = Array(n).fill(-1);
  function search(giver, seen) {
    for (const recipient of choices[giver]) {
      if (seen.has(recipient)) continue;
      seen.add(recipient);
      if (owners[recipient] === -1 || search(owners[recipient], seen)) {
        owners[recipient] = giver;
        return true;
      }
    }
    return false;
  }
  const order = participants.map((_, i) => i).sort((a, b) => choices[a].length - choices[b].length);
  for (const giver of order) {
    if (!search(giver, new Set())) throw new Error('A valid draw is impossible. No household can contain more than half the participants. Add people from other households or review registrations.');
  }
  return owners.map((giver, recipient) => ({ giverId: participants[giver].id, recipientId: participants[recipient].id }));
}
