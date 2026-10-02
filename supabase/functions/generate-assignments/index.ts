import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('generate-assignments', (name: string) => Deno.env.get(name)));
