import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('retry-failed-emails', (name: string) => Deno.env.get(name)));
