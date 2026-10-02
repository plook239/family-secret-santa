import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('remove-participant', (name: string) => Deno.env.get(name)));
