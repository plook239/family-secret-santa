import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('delete-event-data', (name: string) => Deno.env.get(name)));
