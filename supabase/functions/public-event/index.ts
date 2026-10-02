import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('public-event', (name: string) => Deno.env.get(name)));
