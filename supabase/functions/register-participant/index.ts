import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('register-participant', (name: string) => Deno.env.get(name)));
