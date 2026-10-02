import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('create-household', (name: string) => Deno.env.get(name)));
