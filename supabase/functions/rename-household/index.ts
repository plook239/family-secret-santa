import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('rename-household', (name: string) => Deno.env.get(name)));
