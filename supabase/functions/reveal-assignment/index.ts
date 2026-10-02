import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('reveal-assignment', (name: string) => Deno.env.get(name)));
