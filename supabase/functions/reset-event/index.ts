import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('reset-event', (name: string) => Deno.env.get(name)));
