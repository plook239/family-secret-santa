import { solveAssignments } from './assignment.js';
export const STORAGE_KEY = 'family-secret-santa.demo.v1';
const initial = () => ({ version: 1, households: [], participants: [], locked: false, draw: null });
const normalize = value => value.trim().replace(/\s+/g, ' ');
// Fail closed when secure randomness is unavailable. Never use Math.random for tokens.
function token(cryptoApi) {
  if (!cryptoApi?.getRandomValues) throw new Error('Secure randomness is unavailable. Open this app on localhost or HTTPS.');
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function createDemoService(storage, cryptoApi) {
  function read() {
    let raw;
    try { raw = storage.getItem(STORAGE_KEY); } catch { throw new Error('Browser storage is unavailable. Allow local storage to use this demo.'); }
    if (raw === null) return initial();
    try {
      const state = JSON.parse(raw);
      if (state.version !== 1 || !Array.isArray(state.households) || !Array.isArray(state.participants) || typeof state.locked !== 'boolean' || !('draw' in state)) throw new Error();
      return state;
    } catch { throw new Error('Saved demo data could not be read. Clear this site’s browser storage to start again.'); }
  }
  function write(state) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { throw new Error('Could not save. Browser storage may be blocked or full; no changes were saved.'); }
  }
  function editable(state) { if (state.draw) throw new Error('The draw is complete. Reset the event before changing registrations or households.'); }
  function summary(state) {
    return { households: state.households, participants: state.participants, locked: state.locked, drawn: !!state.draw, drawnAt: state.draw?.createdAt ?? null };
  }
  return {
    async getEvent() { return summary(read()); },
    async join({ name, email, householdId }) {
      const state = read(); editable(state);
      if (state.locked) throw new Error('Registration is closed. Please contact the organizer.');
      name = normalize(name); email = email.trim().toLowerCase();
      if (!name || name.length > 80 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a name and a valid email address.');
      if (!state.households.some(h => h.id === householdId)) throw new Error('Choose a household from the list.');
      if (state.participants.some(p => p.email === email || (p.name.toLowerCase() === name.toLowerCase() && p.householdId === householdId))) throw new Error('This email or name in this household is already registered.');
      if (state.participants.length >= 200) throw new Error('This local demo supports up to 200 participants.');
      const participant = { id: token(cryptoApi), name, email, householdId };
      state.participants.push(participant); write(state); return { name };
    },
    async saveHousehold({ id, name }) {
      const state = read(); editable(state); name = normalize(name);
      if (!name || name.length > 60) throw new Error('Household names must be 1–60 characters.');
      if (state.households.some(h => h.id !== id && h.name.toLowerCase() === name.toLowerCase())) throw new Error('That household already exists.');
      if (id) { const household = state.households.find(h => h.id === id); if (!household) throw new Error('Household not found.'); household.name = name; }
      else state.households.push({ id: token(cryptoApi), name });
      write(state);
    },
    async deleteHousehold(id) {
      const state = read(); editable(state);
      if (state.participants.some(p => p.householdId === id)) throw new Error('Only empty households can be deleted.');
      state.households = state.households.filter(h => h.id !== id); write(state);
    },
    async removeParticipant(id) {
      const state = read(); editable(state); state.participants = state.participants.filter(p => p.id !== id); write(state);
    },
    async setLocked(locked) { const state = read(); editable(state); state.locked = !!locked; write(state); },
    async generate() {
      const state = read(); editable(state);
      if (!state.locked) throw new Error('Close registration before drawing names.');
      const pairs = solveAssignments(state.participants);
      const tokens = new Set();
      const assignments = pairs.map(pair => {
        const value = token(cryptoApi);
        if (tokens.has(value)) throw new Error('Token collision. Nothing was saved; please try again.');
        tokens.add(value); return { ...pair, token: value };
      });
      state.draw = { createdAt: new Date().toISOString(), assignments }; write(state);
    },
    async getRevealLinks() {
      const state = read();
      return state.draw ? state.participants.map(p => ({ name: p.name, email: p.email, token: state.draw.assignments.find(a => a.giverId === p.id).token })) : [];
    },
    async reveal(value) {
      const state = read(); const assignment = state.draw?.assignments.find(a => a.token === value);
      if (!assignment) throw new Error('This reveal link is invalid or has expired. Ask your organizer for a current link.');
      return { participantName: state.participants.find(p => p.id === assignment.giverId).name, recipientName: state.participants.find(p => p.id === assignment.recipientId).name };
    },
    async reset(confirmation) {
      if (confirmation !== 'RESET EVENT') throw new Error('Type RESET EVENT exactly to confirm.');
      const state = read(); state.draw = null; state.locked = false; write(state);
    }
  };
}
