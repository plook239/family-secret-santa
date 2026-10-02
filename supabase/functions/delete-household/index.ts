import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('delete-household', (name: string) => Deno.env.get(name)));
