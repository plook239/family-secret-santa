import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('admin-logout', (name: string) => Deno.env.get(name)));
