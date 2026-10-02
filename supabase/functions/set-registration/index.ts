import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('set-registration', (name: string) => Deno.env.get(name)));
