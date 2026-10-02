import { createHandler } from '../_shared/handler.js';
Deno.serve(createHandler('admin-login', (name: string) => Deno.env.get(name)));
