import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('issue-reveal-token', (name: string) => Deno.env.get(name)));
